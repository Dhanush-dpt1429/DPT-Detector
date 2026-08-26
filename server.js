import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import "dotenv/config";

const app = express();

app.use(express.json({ limit: "1mb" }));

const FRONTEND_ORIGIN =
  process.env.FRONTEND_ORIGIN || "*";

app.use(
  cors({
    origin:
      FRONTEND_ORIGIN === "*"
        ? true
        : FRONTEND_ORIGIN,
  })
);

const PORT =
  Number(process.env.PORT || 8787);

const MAX_WORDS = 5000;

/*
=======================================================
PLAGIARISM FILTER SETTINGS
=======================================================
*/

const MIN_MATCH_WORDS = 3;
const MIN_MATCH_PERCENT = 0.1;

/*
=======================================================
GENERAL HELPERS
=======================================================
*/

function wordCount(text) {
  return (
    String(text || "")
      .trim()
      .match(/\S+/g) || []
  ).length;
}

function assertText(text) {
  if (
    typeof text !== "string" ||
    !text.trim()
  ) {
    throw new Error(
      "Text is required."
    );
  }

  const words = wordCount(text);

  if (words > MAX_WORDS) {
    throw new Error(
      `Maximum ${MAX_WORDS.toLocaleString()} words per request.`
    );
  }
}

function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(
      `${name} is not configured on the server.`
    );
  }
}

function createScanId() {
  return crypto
    .randomBytes(12)
    .toString("hex");
}

function cleanUrl(url) {
  if (!url) return "";

  try {
    const parsed =
      new URL(url);

    const removeParams = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "gclid",
      "fbclid",
      "mc_cid",
      "mc_eid"
    ];

    for (
      const parameter
      of removeParams
    ) {
      parsed.searchParams.delete(
        parameter
      );
    }

    return parsed.toString();
  } catch {
    return String(url);
  }
}

/*
=======================================================
UPSTASH REDIS
=======================================================
*/

function requireRedis() {
  requireEnv(
    "UPSTASH_REDIS_REST_URL"
  );

  requireEnv(
    "UPSTASH_REDIS_REST_TOKEN"
  );
}

async function redisCommand(
  command
) {
  requireRedis();

  const baseUrl =
    process.env
      .UPSTASH_REDIS_REST_URL
      .replace(/\/$/, "");

  const url =
    `${baseUrl}/` +
    command
      .map((value) =>
        encodeURIComponent(
          String(value)
        )
      )
      .join("/");

  const response =
    await fetch(url, {
      method: "GET",
      headers: {
        Authorization:
          `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      },
    });

  const raw =
    await response.text();

  let data;

  try {
    data =
      raw
        ? JSON.parse(raw)
        : {};
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

async function saveScan(
  id,
  data
) {
  await redisCommand([
    "set",
    `dpt:scan:${id}`,
    JSON.stringify(data),
    "EX",
    "7200"
  ]);
}

async function getScan(id) {
  const value =
    await redisCommand([
      "get",
      `dpt:scan:${id}`
    ]);

  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    throw new Error(
      "Stored scan data is invalid."
    );
  }
}

async function deleteScan(id) {
  await redisCommand([
    "del",
    `dpt:scan:${id}`
  ]);
}

/*
=======================================================
COPYLEAKS AUTHENTICATION
=======================================================
*/

let copyleaksToken = {
  value: null,
  expiresAt: 0
};

async function getCopyleaksToken() {
  requireEnv(
    "COPYLEAKS_EMAIL"
  );

  requireEnv(
    "COPYLEAKS_API_KEY"
  );

  if (
    copyleaksToken.value &&
    Date.now() <
      copyleaksToken.expiresAt
  ) {
    return copyleaksToken.value;
  }

  const response =
    await fetch(
      "https://id.copyleaks.com/v3/account/login/api",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          Accept:
            "application/json"
        },

        body:
          JSON.stringify({
            email:
              process.env.COPYLEAKS_EMAIL,

            key:
              process.env.COPYLEAKS_API_KEY
          })
      }
    );

  const raw =
    await response.text();

  let data = {};

  try {
    data =
      raw
        ? JSON.parse(raw)
        : {};
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
      "Copyleaks did not return an access token."
    );
  }

  /*
    Copyleaks tokens are valid for a long period.
    Refresh slightly before expiration.
  */

  copyleaksToken = {
    value:
      data.access_token,

    expiresAt:
      Date.now() +
      43 * 60 * 60 * 1000
  };

  return data.access_token;
}

/*
=======================================================
NORMALIZE INTERNET SOURCES
=======================================================
*/

function normalizeInternetResults(
  results,
  totalWords
) {
  if (
    !Array.isArray(results)
  ) {
    return [];
  }

  const unique =
    new Map();

  for (
    const item
    of results
  ) {
    const matchedWords =
      Number(
        item?.matchedWords || 0
      );

    if (
      !Number.isFinite(
        matchedWords
      )
    ) {
      continue;
    }

    /*
      Ignore extremely tiny matches.

      1-2 words are normally
      not useful evidence.
    */

    if (
      matchedWords <
      MIN_MATCH_WORDS
    ) {
      continue;
    }

    const matchPercent =
      totalWords > 0
        ? (
            matchedWords /
            totalWords
          ) *
          100
        : 0;

    if (
      matchPercent <
      MIN_MATCH_PERCENT
    ) {
      continue;
    }

    /*
      Prefer canonical URL,
      then final URL,
      then normal URL.
    */

    const rawUrl =
      item?.metadata?.canonicalUrl ||
      item?.metadata?.finalUrl ||
      item?.url ||
      "";

    const url =
      cleanUrl(rawUrl);

    if (!url) {
      continue;
    }

    const key =
      url
        .toLowerCase()
        .replace(/\/+$/, "");

    const normalized = {
      id:
        item?.id || "",

      title:
        item?.title ||
        url,

      introduction:
        item?.introduction ||
        "",

      url,

      matchedWords,

      matchPercent:
        Number(
          matchPercent.toFixed(2)
        ),

      metadata:
        item?.metadata || {},

      tags:
        Array.isArray(
          item?.tags
        )
          ? item.tags
          : []
    };

    const existing =
      unique.get(key);

    if (
      !existing ||
      normalized.matchedWords >
        existing.matchedWords
    ) {
      unique.set(
        key,
        normalized
      );
    }
  }

  return Array
    .from(unique.values())
    .sort(
      (a, b) =>
        b.matchedWords -
        a.matchedWords
    );
}

/*
=======================================================
CALCULATE VERIFIED SOURCE COVERAGE
=======================================================

This is NOT used as a replacement for Copyleaks'
official aggregated plagiarism score.

It is an additional transparent statistic showing
how much of the submitted document is represented by
the returned source matches.

Because multiple sources can overlap, this should be
treated as source coverage, not a perfect plagiarism
percentage.
*/

function calculateSourceCoverage(
  results,
  totalWords
) {
  if (
    !totalWords ||
    !results.length
  ) {
    return 0;
  }

  const totalMatched =
    results.reduce(
      (sum, item) =>
        sum +
        Number(
          item.matchedWords || 0
        ),
      0
    );

  return Number(
    Math.min(
      100,
      (
        totalMatched /
        totalWords
      ) *
        100
    ).toFixed(2)
  );
}

/*
=======================================================
HEALTH
=======================================================
*/

app.get(
  "/api/health",
  (req, res) => {
    res.set(
      "Cache-Control",
      "no-store"
    );

    res.json({
      ok: true,
      service:
        "DPT-Detector",
      plagiarismProvider:
        "Copyleaks",
      sandbox:
        process.env.COPYLEAKS_SANDBOX ===
        "true",
      time:
        new Date().toISOString()
    });
  }
);

/*
=======================================================
PLAGIARISM SUBMIT
=======================================================
*/

app.post(
  "/api/plagiarism",
  async (req, res) => {
    try {
      const {
        text
      } = req.body;

      assertText(text);

      const id =
        createScanId();

      const totalWords =
        wordCount(text);

      const webhookBase =
        process.env.PUBLIC_BACKEND_URL;

      if (!webhookBase) {
        throw new Error(
          "PUBLIC_BACKEND_URL is not configured."
        );
      }

      const token =
        await getCopyleaksToken();

      const baseUrl =
        webhookBase
          .replace(/\/$/, "");

      /*
        IMPORTANT:
        Never use sandbox for production
        plagiarism results.
      */

      const sandbox =
        process.env.COPYLEAKS_SANDBOX ===
        "true";

      await saveScan(
        id,
        {
          status:
            "submitted",

          createdAt:
            Date.now(),

          totalWords,

          results:
            null,

          document:
            null,

          error:
            null,

          provider:
            "Copyleaks",

          sandbox
        }
      );

      const submission = {
        base64:
          Buffer
            .from(
              text,
              "utf8"
            )
            .toString(
              "base64"
            ),

        filename:
          "dpt-detector.txt",

        properties: {
          webhooks: {
            status:
              `${baseUrl}/webhooks/copyleaks/{STATUS}/${id}`,

            newResult:
              `${baseUrl}/webhooks/copyleaks/new-result/${id}`
          },

          scanning: {
            internet:
              true
          },

          filters: {
            identicalEnabled:
              true,

            minorChangesEnabled:
              true,

            relatedMeaningEnabled:
              true
          },

          sandbox,

          developerPayload:
            id
        }
      };

      const response =
        await fetch(
          `https://api.copyleaks.com/v3/scans/submit/file/${id}`,
          {
            method:
              "PUT",

            headers: {
              Authorization:
                `Bearer ${token}`,

              "Content-Type":
                "application/json",

              Accept:
                "application/json"
            },

            body:
              JSON.stringify(
                submission
              )
          }
        );

      const raw =
        await response.text();

      let data = {};

      try {
        data =
          raw
            ? JSON.parse(raw)
            : {};
      } catch {
        data = {};
      }

      if (!response.ok) {
        await deleteScan(id);

        throw new Error(
          data.message ||
            data.error ||
            `Copyleaks submission failed (${response.status}).`
        );
      }

      const current =
        await getScan(id);

      await saveScan(
        id,
        {
          ...(current || {}),

          status:
            "submitted",

          providerResponse:
            data,

          submittedAt:
            Date.now()
        }
      );

      console.log(
        "Copyleaks scan submitted:",
        id
      );

      console.log(
        "Sandbox:",
        sandbox
      );

      res.status(202).json({
        scanId:
          id,

        status:
          "submitted"
      });
    } catch (error) {
      console.error(
        "Plagiarism submission error:",
        error
      );

      res.status(400).json({
        error:
          error.message ||
          "Plagiarism check failed."
      });
    }
  }
);

/*
=======================================================
PLAGIARISM STATUS
=======================================================
*/

app.get(
  "/api/plagiarism/:id",
  async (req, res) => {
    try {
      const scan =
        await getScan(
          req.params.id
        );

      if (!scan) {
        return res
          .status(404)
          .json({
            error:
              "Scan not found or expired."
          });
      }

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
          "Could not retrieve scan status."
      });
    }
  }
);

/*
=======================================================
COPYLEAKS STATUS WEBHOOK
=======================================================
*/

async function acceptWebhook(
  req,
  res
) {
  const id =
    req.params.id;

  const status =
    req.params.status;

  try {
    console.log(
      `Copyleaks webhook: ${status} / ${id}`
    );

    const scan =
      await getScan(id);

    if (!scan) {
      console.warn(
        `Unknown scan ID: ${id}`
      );

      return res
        .status(200)
        .json({
          ok: true
        });
    }

    const payload =
      req.body || {};

    scan.webhookAt =
      Date.now();

    scan.lastWebhookStatus =
      status;

    /*
    =====================================================
    COMPLETED
    =====================================================
    */

    if (
      status ===
      "completed"
    ) {
      const scannedDocument =
        payload.scannedDocument ||
        {};

      const totalWords =
        Number(
          scannedDocument.totalWords ||
          payload.totalWords ||
          scan.totalWords ||
          0
        );

      const rawResults =
        payload.results?.internet ||
        payload.internet ||
        [];

      const filteredResults =
        normalizeInternetResults(
          rawResults,
          totalWords
        );

      const providerScore =
        Number(
          payload.results
            ?.score
            ?.aggregatedScore
        );

      const providerScoreValid =
        Number.isFinite(
          providerScore
        );

      const sourceCoverage =
        calculateSourceCoverage(
          filteredResults,
          totalWords
        );

      /*
        IMPORTANT:

        Keep Copyleaks' official score.

        Do NOT replace it with:
          100 - score
        until the frontend explicitly
        interprets it as originality.
      */

      scan.status =
        "completed";

      scan.results = {
        score:
          payload.results?.score ||
          {},

        internet:
          filteredResults,

        database:
          payload.results?.database ||
          [],

        repositories:
          payload.results?.repositories ||
          [],

        internalAIData:
          payload.results?.internalAIData ||
          [],

        /*
          Additional DPT statistics.
        */

        sourceCoverage,

        totalInternetSources:
          filteredResults.length,

        rawInternetSources:
          rawResults.length,

        filteredOutSources:
          Math.max(
            0,
            rawResults.length -
              filteredResults.length
          ),

        providerScore:
          providerScoreValid
            ? providerScore
            : null
      };

      scan.document =
        scannedDocument;

      scan.notifications =
        payload.notifications ||
        {};

      scan.totalWords =
        totalWords;

      scan.completedAt =
        Date.now();

      /*
        If sandbox mode is accidentally enabled,
        make that visible in the result.
      */

      scan.warning =
        scan.sandbox
          ? "SANDBOX MODE IS ENABLED. RESULTS ARE MOCK RESULTS AND MUST NOT BE PRESENTED AS REAL PLAGIARISM RESULTS."
          : null;

      console.log(
        "Copyleaks scan completed:",
        id
      );

      console.log(
        "Total words:",
        totalWords
      );

      console.log(
        "Raw internet sources:",
        rawResults.length
      );

      console.log(
        "Meaningful sources:",
        filteredResults.length
      );

      console.log(
        "Provider similarity:",
        providerScore
      );

      console.log(
        "Source coverage:",
        sourceCoverage
      );
    }

    /*
    =====================================================
    ERROR
    =====================================================
    */

    else if (
      status ===
      "error"
    ) {
      scan.status =
        "error";

      scan.error =
        payload.error?.message ||
        payload.message ||
        "Copyleaks scan failed.";

      scan.completedAt =
        Date.now();
    }

    /*
    =====================================================
    OTHER STATUS
    =====================================================
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

    return res
      .status(200)
      .json({
        ok: true
      });
  } catch (error) {
    console.error(
      "Copyleaks webhook error:",
      error
    );

    return res
      .status(500)
      .json({
        error:
          "Webhook processing failed."
      });
  }
}

app.post(
  "/webhooks/copyleaks/:status/:id",
  acceptWebhook
);

/*
=======================================================
NEW RESULT WEBHOOK
=======================================================
*/

app.post(
  "/webhooks/copyleaks/new-result/:id",
  async (req, res) => {
    const id =
      req.params.id;

    try {
      const scan =
        await getScan(id);

      if (!scan) {
        return res
          .status(200)
          .json({
            ok: true
          });
      }

      const payload =
        req.body || {};

      scan.liveResults =
        scan.liveResults || [];

      const totalWords =
        Number(
          scan.totalWords || 0
        );

      /*
        Copyleaks' new-result
        payload contains the current
        internet result.
      */

      const incoming =
        [];

      if (
        Array.isArray(
          payload.internet
        )
      ) {
        incoming.push(
          ...payload.internet
        );
      }

      /*
        Sometimes a single result
        is returned rather than an array.
      */

      if (
        payload.url ||
        payload.matchedWords
      ) {
        incoming.push(
          payload
        );
      }

      const normalized =
        normalizeInternetResults(
          incoming,
          totalWords
        );

      for (
        const result
        of normalized
      ) {
        const exists =
          scan.liveResults.some(
            item =>
              item.url ===
              result.url
          );

        if (!exists) {
          scan.liveResults.push(
            result
          );
        }
      }

      await saveScan(
        id,
        scan
      );

      return res
        .status(200)
        .json({
          ok: true
        });
    } catch (error) {
      console.error(
        "Copyleaks new-result error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Webhook processing failed."
        });
    }
  }
);

/*
=======================================================
GEMINI REWRITE
=======================================================
*/

app.post(
  "/api/rewrite",
  async (req, res) => {
    try {
      const {
        text,
        style = "Natural"
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

Rewrite the user's text so it sounds natural, fluent, clear and well-written.

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
        await fetch(
          url,
          {
            method:
              "POST",

            headers: {
              "Content-Type":
                "application/json"
            },

            body:
              JSON.stringify({
                contents: [
                  {
                    parts: [
                      {
                        text:
                          prompt
                      }
                    ]
                  }
                ],

                generationConfig: {
                  temperature:
                    0.8
                }
              })
          }
        );

      const raw =
        await response.text();

      let data = {};

      try {
        data =
          raw
            ? JSON.parse(raw)
            : {};
      } catch {
        data = {};
      }

      if (!response.ok) {
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
            part =>
              part.text ||
              ""
          )
          .join("")
          .trim();

      if (!output) {
        throw new Error(
          "Gemini returned an empty response."
        );
      }

      res.json({
        text:
          output
      });
    } catch (error) {
      console.error(
        "Rewrite error:",
        error
      );

      res.status(400).json({
        error:
          error.message ||
          "Rewrite failed."
      });
    }
  }
);

/*
=======================================================
UNKNOWN API
=======================================================
*/

app.use(
  "/api",
  (req, res) => {
    res.status(404).json({
      error:
        "API endpoint not found."
    });
  }
);

/*
=======================================================
LOCAL / VERCEL
=======================================================
*/

if (!process.env.VERCEL) {
  app.listen(
    PORT,
    () => {
      console.log(
        `DPT-Detector backend running on port ${PORT}`
      );
    }
  );
}

export default app;