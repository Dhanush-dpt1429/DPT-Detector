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
const scans = new Map();

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

  const r = await fetch(
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

  const raw = await r.text();

  let d = {};

  try {
    d = raw ? JSON.parse(raw) : {};
  } catch {
    d = {};
  }

  if (!r.ok) {
    throw new Error(
      d.message ||
        d.error ||
        `Copyleaks authentication failed (${r.status}).`
    );
  }

  if (!d.access_token) {
    throw new Error(
      "Copyleaks authentication succeeded but no access token was returned."
    );
  }

  copyleaksToken = {
    value: d.access_token,
    expiresAt: Date.now() + 43 * 60 * 60 * 1000,
  };

  return d.access_token;
}

/* -------------------------------------------------------
   HEALTH
------------------------------------------------------- */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "DPT-Detector",
    time: new Date().toISOString(),
  });
});

/* -------------------------------------------------------
   PLAGIARISM
------------------------------------------------------- */

app.post("/api/plagiarism", async (req, res) => {
  try {
    const { text } = req.body;

    assertText(text);

    const id = scanId();

    const webhookBase = process.env.PUBLIC_BACKEND_URL;

    if (!webhookBase) {
      throw new Error(
        "PUBLIC_BACKEND_URL is not configured. The plagiarism provider needs a public HTTPS webhook URL."
      );
    }

    const token = await getCopyleaksToken();

    scans.set(id, {
      status: "submitted",
      createdAt: Date.now(),
      results: null,
      error: null,
    });

    const baseUrl = webhookBase.replace(/\/$/, "");

    const body = {
      base64: Buffer.from(text, "utf8").toString("base64"),

      filename: "dpt-detector.txt",

      properties: {
        webhooks: {
          status: `${baseUrl}/webhooks/copyleaks/{STATUS}/${id}`,

          newResult: `${baseUrl}/webhooks/copyleaks/new-result/${id}`,
        },

        scanning: {
          internet: true,
        },

        filters: {
          identicalEnabled: true,
          minorChangesEnabled: true,
          relatedMeaningEnabled: true,
        },

        sandbox: process.env.COPYLEAKS_SANDBOX === "true",

        developerPayload: id,
      },
    };

    const r = await fetch(
      `https://api.copyleaks.com/v3/scans/submit/file/${id}`,
      {
        method: "PUT",

        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },

        body: JSON.stringify(body),
      }
    );

    const raw = await r.text();

    let d = {};

    try {
      d = raw ? JSON.parse(raw) : {};
    } catch {
      d = {};
    }

    if (!r.ok) {
      scans.delete(id);

      throw new Error(
        d.message ||
          d.error ||
          `Copyleaks scan submission failed (${r.status}).`
      );
    }

    scans.get(id).provider = d;

    res.status(202).json({
      scanId: id,
      status: "submitted",
    });
  } catch (e) {
    console.error("Plagiarism error:", e);

    res.status(400).json({
      error: e.message || "Plagiarism check failed.",
    });
  }
});

/* -------------------------------------------------------
   PLAGIARISM STATUS
------------------------------------------------------- */

app.get("/api/plagiarism/:id", (req, res) => {
  const s = scans.get(req.params.id);

  if (!s) {
    return res.status(404).json({
      error: "Scan not found or expired.",
    });
  }

  res.json(s);
});

/* -------------------------------------------------------
   COPYLEAKS WEBHOOK
------------------------------------------------------- */

function acceptWebhook(req, res) {
  const id = req.params.id;

  const s = scans.get(id);

  if (!s) {
    return res.status(200).json({
      ok: true,
    });
  }

  const payload = req.body || {};

  s.webhookAt = Date.now();

  if (req.params.status === "completed") {
    s.status = "completed";

    s.results = payload.results || {};

    s.document = payload.scannedDocument || {};
  } else if (req.params.status === "error") {
    s.status = "error";

    s.error =
      payload.error?.message ||
      "The plagiarism scan failed.";
  } else {
    s.status = req.params.status || "processing";
  }

  res.status(200).json({
    ok: true,
  });
}

app.post(
  "/webhooks/copyleaks/:status/:id",
  acceptWebhook
);

app.post(
  "/webhooks/copyleaks/new-result/:id",
  (req, res) => {
    const s = scans.get(req.params.id);

    if (s) {
      s.liveResults = s.liveResults || [];

      if (req.body?.internet) {
        s.liveResults.push(...req.body.internet);
      }
    }

    res.status(200).json({
      ok: true,
    });
  }
);

/* -------------------------------------------------------
   GEMINI NATURAL REWRITE
------------------------------------------------------- */

app.post("/api/rewrite", async (req, res) => {
  try {
    const {
      text,
      style = "Natural",
    } = req.body;

    assertText(text);

    requireEnv("GEMINI_API_KEY");

    const model =
      process.env.GEMINI_MODEL ||
      "gemini-2.5-flash";

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
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;

    const r = await fetch(url, {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
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

    const raw = await r.text();

    let d = {};

    try {
      d = raw ? JSON.parse(raw) : {};
    } catch {
      d = {};
    }

    if (!r.ok) {
      console.error("Gemini API error:", r.status, raw);

      throw new Error(
        d.error?.message ||
          `Gemini API request failed (${r.status}).`
      );
    }

    const output =
      d.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || "")
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
  } catch (e) {
    console.error("Rewrite error:", e);

    res.status(400).json({
      error: e.message || "Rewrite failed.",
    });
  }
});

/* -------------------------------------------------------
   START SERVER
------------------------------------------------------- */

app.listen(PORT, () => {
  console.log(
    `DPT-Detector backend running on port ${PORT}`
  );
});
