import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import "dotenv/config";

const app = express();

app.use(express.json({ limit: "1mb" }));

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";

app.use(
  cors({
    origin: FRONTEND_ORIGIN === "*" ? true : FRONTEND_ORIGIN,
  })
);

const PORT = Number(process.env.PORT || 8787);
const MAX_WORDS = 5000;

/* -------------------------------------------------------
   GENERAL HELPERS
------------------------------------------------------- */

function wordCount(text) {
  return (String(text || "").trim().match(/\S+/g) || []).length;
}

function assertText(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Text is required.");
  }

  if (wordCount(text) > MAX_WORDS) {
    throw new Error("Maximum 5,000 words per request.");
  }
}

function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`${name} is not configured on the server.`);
  }
}

function scanId() {
  return crypto.randomBytes(12).toString("hex");
}

/* -------------------------------------------------------
   UPSTASH REDIS
------------------------------------------------------- */

function requireRedis() {
  requireEnv("UPSTASH_REDIS_REST_URL");
  requireEnv("UPSTASH_REDIS_REST_TOKEN");
}

async function redisCommand(command) {
  requireRedis();

  const baseUrl = process.env.UPSTASH_REDIS_REST_URL.replace(/\/$/, "");

  const url =
    `${baseUrl}/` +
    command
      .map((value) => encodeURIComponent(String(value)))
      .join("/");

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization:
        `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
    },
  });

  const raw = await response.text();

  let data;

  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(
      `Redis returned invalid JSON (${response.status}).`
    );
  }

  if (!response.ok) {
    throw new Error(
      data.error ||
        data.message ||
        `Redis request failed (${response.status}).`
    );
  }

  return data.result;
}

async function saveScan(id, data) {
  await redisCommand([
    "set",
    `dpt:scan:${id}`,
    JSON.stringify(data),
    "EX",
    "7200",
  ]);
}

async function getScan(id) {
  const value = await redisCommand([
    "get",
    `dpt:scan:${id}`,
  ]);

  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Stored scan data is invalid.");
  }
}

async function deleteScan(id) {
  await redisCommand([
    "del",
    `dpt:scan:${id}`,
  ]);
}

/* -------------------------------------------------------
   COPYLEAKS AUTHENTICATION
------------------------------------------------------- */

let copyleaksToken = {
  value: null,
  expiresAt: 0,
};

async function getCopyleaksToken() {
  requireEnv("COPYLEAKS_EMAIL");
  requireEnv("COPYLEAKS_API_KEY");

  if (
    copyleaksToken.value &&
    Date.now() < copyleaksToken.expiresAt
  ) {
    return copyleaksToken.value;
  }

  const response = await fetch(
    "https://id.copyleaks.com/v3/account/login/api",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        email: process.env.COPYLEAKS_EMAIL,
        key: process.env.COPYLEAKS_API_KEY,
      }),
    }
  );

  const raw = await response.text();

  let data = {};

  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = {};
  }

  if (!response.ok) {
    throw new Error(
      data.message ||
        data.error ||
        `Copyleaks authentication failed (${response.status}).`
    );
  }

  if (!data.access_token) {
    throw new Error(
      "Copyleaks authentication succeeded but no access token was returned."
    );
  }

  copyleaksToken = {
    value: data.access_token,

    // Copyleaks tokens normally last around 48 hours.
    // Refresh slightly before expiration.
    expiresAt:
      Date.now() + 43 * 60 * 60 * 1000,
  };

  return data.access_token;
}

/* -------------------------------------------------------
   HEALTH
------------------------------------------------------- */

app.get("/api/health", (req, res) => {
  res.set("Cache-Control", "no-store");

  res.json({
    ok: true,
    service: "DPT-Detector",
    time: new Date().toISOString(),
  });
});

/* -------------------------------------------------------
   PLAGIARISM - SUBMIT
------------------------------------------------------- */

app.post("/api/plagiarism", async (req, res) => {
  try {
    const { text } = req.body;

    assertText(text);

    const id = scanId();

    const webhookBase =
      process.env.PUBLIC_BACKEND_URL;

    if (!webhookBase) {
      throw new Error(
        "PUBLIC_BACKEND_URL is not configured. The plagiarism provider needs a public HTTPS webhook URL."
      );
    }

    const token =
      await getCopyleaksToken();

    const baseUrl =
      webhookBase.replace(/\/$/, "");

    /*
      Save the scan BEFORE submitting it to Copyleaks.

      This is important because the webhook can arrive
      independently of the original request.
    */

    await saveScan(id, {
      status: "submitted",
      createdAt: Date.now(),
      results: null,
      document: null,
      error: null,
    });

    const submission = {
      base64:
        Buffer.from(text, "utf8").toString("base64"),

      filename: "dpt-detector.txt",

      properties: {
        webhooks: {
          status:
            `${baseUrl}/webhooks/copyleaks/{STATUS}/${id}`,

          newResult:
            `${baseUrl}/webhooks/copyleaks/new-result/${id}`,
        },

        scanning: {
          internet: true,
        },

        filters: {
          identicalEnabled: true,
          minorChangesEnabled: true,
          relatedMeaningEnabled: true,
        },

        sandbox:
          process.env.COPYLEAKS_SANDBOX === "true",

        developerPayload: id,
      },
    };

    const response = await fetch(
      `https://api.copyleaks.com/v3/scans/submit/file/${id}`,
      {
        method: "PUT",

        headers: {
          Authorization:
            `Bearer ${token}`,

          "Content-Type":
            "application/json",

          Accept:
            "application/json",
        },

        body:
          JSON.stringify(submission),
      }
    );

    const raw =
      await response.text();

    let data = {};

    try {
      data =
        raw ? JSON.parse(raw) : {};
    } catch {
      data = {};
    }

    if (!response.ok) {
      await deleteScan(id);

      throw new Error(
        data.message ||
          data.error ||
          `Copyleaks scan submission failed (${response.status}).`
      );
    }

    const current =
      await getScan(id);

    await saveScan(id, {
      ...(current || {}),
      status: "submitted",
      provider: data,
      submittedAt: Date.now(),
    });

    console.log(
      "Copyleaks scan submitted:",
      id
    );

    res.status(202).json({
      scanId: id,
      status: "submitted",
    });
  } catch (error) {
    console.error(
      "Plagiarism submission error:",
      error
    );

    res.status(400).json({
      error:
        error.message ||
        "Plagiarism check failed.",
    });
  }
});

/* -------------------------------------------------------
   PLAGIARISM - STATUS
------------------------------------------------------- */

app.get(
  "/api/plagiarism/:id",
  async (req, res) => {
    try {
      const scan =
        await getScan(req.params.id);

      if (!scan) {
        return res.status(404).json({
          error:
            "Scan not found or expired.",
        });
      }

      /*
        Prevent Vercel/browser/CDN caching.

        This also fixes the 304 responses you were seeing.
      */

      res.set(
        "Cache-Control",
        "no-store, no-cache, must-revalidate, proxy-revalidate"
      );

      res.set(
        "Pragma",
        "no-cache"
      );

      res.set(
        "Expires",
        "0"
      );

      res.json(scan);
    } catch (error) {
      console.error(
        "Plagiarism status error:",
        error
      );

      res.status(500).json({
        error:
          error.message ||
          "Could not retrieve scan status.",
      });
    }
  }
);

/* -------------------------------------------------------
   COPYLEAKS STATUS WEBHOOK
------------------------------------------------------- */

async function acceptWebhook(req, res) {
  const id = req.params.id;
  const status = req.params.status;

  try {
    console.log(
      `Copyleaks webhook received: ${status} / ${id}`
    );

    const scan =
      await getScan(id);

    /*
      Copyleaks can retry webhooks.
      Returning 200 for an unknown scan prevents
      unnecessary repeated delivery attempts.
    */

    if (!scan) {
      console.warn(
        `Unknown Copyleaks scan ID: ${id}`
      );

      return res.status(200).json({
        ok: true,
      });
    }

    const payload =
      req.body || {};

    scan.webhookAt =
      Date.now();

    scan.lastWebhookStatus =
      status;

    /*
      COMPLETED
    */

    if (status === "completed") {
      scan.status =
        "completed";

      /*
        Copyleaks' completed webhook includes
        results directly in the payload.
      */

      scan.results =
        payload.results || {};

      scan.document =
        payload.scannedDocument || {};

      scan.notifications =
        payload.notifications || {};

      scan.completedAt =
        Date.now();

      console.log(
        `Copyleaks scan completed: ${id}`
      );
    }

    /*
      ERROR
    */

    else if (status === "error") {
      scan.status =
        "error";

      scan.error =
        payload.error?.message ||
        payload.message ||
        "The Copyleaks plagiarism scan failed.";

      scan.completedAt =
        Date.now();

      console.error(
        `Copyleaks scan failed: ${id}`,
        scan.error
      );
    }

    /*
      Other Copyleaks statuses
      such as creditsChecked/indexed.
    */

    else {
      scan.status =
        status ||
        "processing";
    }

    await saveScan(
      id,
      scan
    );

    return res.status(200).json({
      ok: true,
    });
  } catch (error) {
    console.error(
      "Copyleaks webhook error:",
      error
    );

    /*
      Return 500 so Copyleaks can retry
      the webhook when our storage/backend
      temporarily fails.
    */

    return res.status(500).json({
      error:
        "Webhook processing failed.",
    });
  }
}

app.post(
  "/webhooks/copyleaks/:status/:id",
  acceptWebhook
);

/* -------------------------------------------------------
   COPYLEAKS NEW RESULT WEBHOOK
------------------------------------------------------- */

app.post(
  "/webhooks/copyleaks/new-result/:id",
  async (req, res) => {
    const id =
      req.params.id;

    try {
      console.log(
        `Copyleaks new-result webhook: ${id}`
      );

      const scan =
        await getScan(id);

      if (!scan) {
        return res.status(200).json({
          ok: true,
        });
      }

      const payload =
        req.body || {};

      scan.liveResults =
        scan.liveResults || [];

      /*
        Copyleaks may send internet/database/
        repositories depending on enabled features.
      */

      if (
        Array.isArray(
          payload.internet
        )
      ) {
        scan.liveResults.push(
          ...payload.internet
        );
      }

      if (
        Array.isArray(
          payload.database
        )
      ) {
        scan.liveResults.push(
          ...payload.database
        );
      }

      await saveScan(
        id,
        scan
      );

      res.status(200).json({
        ok: true,
      });
    } catch (error) {
      console.error(
        "Copyleaks new-result webhook error:",
        error
      );

      res.status(500).json({
        error:
          "Webhook processing failed.",
      });
    }
  }
);

/* -------------------------------------------------------
   GEMINI NATURAL REWRITE
------------------------------------------------------- */

app.post(
  "/api/rewrite",
  async (req, res) => {
    try {
      const {
        text,
        style = "Natural",
      } = req.body;

      assertText(text);

      requireEnv(
        "GEMINI_API_KEY"
      );

      const model =
        process.env.GEMINI_MODEL ||
        "gemini-3.6-flash";

      const prompt = `
You are DPT-Detector's writing improvement engine.

Rewrite the user's text so it sounds genuinely natural, fluent, clear, and well-written.

Style: ${style}

Requirements:
- Preserve the original meaning.
- Preserve important facts.
- Do not invent information.
- Improve sentence variety.
- Improve transitions.
- Improve awkward phrasing.
- Use natural vocabulary.
- Keep approximately the same amount of information.
- Do not add an introduction or explanation.
- Return ONLY the rewritten text.
- Do not discuss AI detection or plagiarism detection.

USER TEXT:

${text}
`;

      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
          model
        )}:generateContent?key=${encodeURIComponent(
          process.env.GEMINI_API_KEY
        )}`;

      const response =
        await fetch(url, {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",
          },

          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: prompt,
                  },
                ],
              },
            ],

            generationConfig: {
              temperature: 0.8,
            },
          }),
        });

      const raw =
        await response.text();

      let data = {};

      try {
        data =
          raw ? JSON.parse(raw) : {};
      } catch {
        data = {};
      }

      if (!response.ok) {
        console.error(
          "Gemini API error:",
          response.status,
          raw
        );

        throw new Error(
          data.error?.message ||
            `Gemini API request failed (${response.status}).`
        );
      }

      const output =
        data
          .candidates?.[0]
          ?.content?.parts
          ?.map(
            (part) =>
              part.text || ""
          )
          .join("")
          .trim();

      if (!output) {
        throw new Error(
          "Gemini returned an empty response."
        );
      }

      res.json({
        text: output,
      });
    } catch (error) {
      console.error(
        "Rewrite error:",
        error
      );

      res.status(400).json({
        error:
          error.message ||
          "Rewrite failed.",
      });
    }
  }
);

/* -------------------------------------------------------
   404 API HANDLER
------------------------------------------------------- */

app.use(
  "/api",
  (req, res) => {
    res.status(404).json({
      error:
        "API endpoint not found.",
    });
  }
);

/* -------------------------------------------------------
   VERCEL / LOCAL SERVER
------------------------------------------------------- */

/*
  Vercel can use the Express app directly.

  When running locally with:
      npm start

  the server will listen on PORT.

  On Vercel, the platform handles
  the HTTP server.
*/

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(
      `DPT-Detector backend running on port ${PORT}`
    );
  });
}

export default app;