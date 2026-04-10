// ═══════════════════════════════════════════════════════════════
// HIREAXIS ADMIN ROUTES — /api/admin/*
// Super admin only — manages all client organizations
// ═══════════════════════════════════════════════════════════════

import { Router } from "express";
import mongoose from "mongoose";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import jwt from "jsonwebtoken";
import OpenAI from "openai";

const router = Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const JWT_SECRET = process.env.JWT_SECRET || "hireaxis_secret_key";

// ─── Organization Schema ───
const orgSchema = new mongoose.Schema({
  name: { type: String, required: true },
  website: String,
  about: String,
  industry: String,
  logoUrl: String,

  // AI Interviewer persona
  interviewer: {
    name: { type: String, default: "Hiring Manager" },
    avatarUrl: String,
    personality: {
      type: String,
      default: "Professional, warm, and encouraging. Asks follow-up questions naturally.",
    },
  },

  // Interview channels
  channels: {
    web: { type: Boolean, default: true },
    phone: { type: Boolean, default: false },
    embed: { type: Boolean, default: false },
    phoneNumber: String,
  },

  // AI Knowledge base — injected into the ElevenLabs agent context
  aiKnowledge: {
    companyInfo: String,
    benefits: String,
    culture: String,
    faq: String,
    scrapedContent: String,
    lastScraped: Date,
  },

  // Plan & billing
  plan: {
    type: String,
    enum: ["trial", "starter", "pro", "enterprise"],
    default: "trial",
  },
  status: {
    type: String,
    enum: ["active", "paused", "suspended"],
    default: "active",
  },
  trial: {
    interviewLimit: { type: Number, default: 20 },
    interviewsUsed: { type: Number, default: 0 },
    startDate: { type: Date, default: Date.now },
  },

  stats: {
    roles: { type: Number, default: 0 },
    interviews: { type: Number, default: 0 },
    avgScore: { type: Number, default: 0 },
  },

  companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company" },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

orgSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

const Org =
  mongoose.models.Organization ||
  mongoose.model("Organization", orgSchema);

// ─── Super admin auth middleware ───
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer "))
    return res.status(401).json({ error: "Unauthorized" });
  try {
    const decoded = jwt.verify(auth.split(" ")[1], JWT_SECRET);
    // Allow admin or super_admin role
    if (decoded.role !== "admin" && decoded.role !== "super_admin") {
      return res.status(403).json({ error: "Admin access required" });
    }
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

router.use(requireAdmin);

// ─── Logo upload (multer) ───
const uploadDir = path.join(__dirname, "..", "uploads", "logos");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `logo_${req.body.orgId || Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [".png", ".jpg", ".jpeg", ".svg", ".webp", ".gif"];
    if (allowed.includes(path.extname(file.originalname).toLowerCase()))
      cb(null, true);
    else cb(new Error("Invalid file type"));
  },
});

// ═══════════════════════════════════════════
// HELPER — Build AI context from org data
// ═══════════════════════════════════════════
function buildAIContext(org) {
  const sections = [];

  sections.push(`You are an AI interviewer representing ${org.name}.`);

  if (org.interviewer?.personality) {
    sections.push(`PERSONALITY: ${org.interviewer.personality}`);
  }
  if (org.interviewer?.name) {
    sections.push(
      `Your name is ${org.interviewer.name}. Introduce yourself by this name.`
    );
  }
  if (org.about) {
    sections.push(`ABOUT ${org.name.toUpperCase()}:\n${org.about}`);
  }
  if (org.aiKnowledge?.companyInfo) {
    sections.push(`COMPANY INFORMATION:\n${org.aiKnowledge.companyInfo}`);
  }
  if (org.aiKnowledge?.benefits) {
    sections.push(`BENEFITS & PERKS:\n${org.aiKnowledge.benefits}`);
  }
  if (org.aiKnowledge?.culture) {
    sections.push(`CULTURE & VALUES:\n${org.aiKnowledge.culture}`);
  }
  if (org.aiKnowledge?.faq) {
    sections.push(
      `FREQUENTLY ASKED QUESTIONS:\nWhen candidates ask any of these questions, use the provided answers:\n${org.aiKnowledge.faq}`
    );
  }
  if (org.website) {
    sections.push(`Company website: ${org.website}`);
  }

  sections.push(`
IMPORTANT RULES:
- Answer candidate questions about ${org.name} naturally and confidently using the information above.
- If a candidate asks something not covered above, say you'll connect them with the hiring team for specifics.
- Never make up information about the company — only use what's been provided.
- Be conversational, not robotic. Use the information to have a natural discussion.
- When discussing benefits or culture, be enthusiastic but honest.`);

  return sections.join("\n\n");
}

// ═══════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════

// GET /api/admin/orgs — List all organizations
router.get("/orgs", async (req, res) => {
  try {
    const orgs = await Org.find().sort({ createdAt: -1 });
    res.json({ orgs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/orgs/:id — Get single org
router.get("/orgs/:id", async (req, res) => {
  try {
    const org = await Org.findById(req.params.id);
    if (!org) return res.status(404).json({ error: "Organization not found" });
    res.json(org);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/orgs — Create new org
router.post("/orgs", async (req, res) => {
  try {
    const org = new Org(req.body);
    await org.save();
    res.status(201).json(org);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// PUT /api/admin/orgs/:id — Update org
router.put("/orgs/:id", async (req, res) => {
  try {
    const org = await Org.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!org) return res.status(404).json({ error: "Organization not found" });
    res.json(org);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/admin/orgs/:id — Delete org
router.delete("/orgs/:id", async (req, res) => {
  try {
    const org = await Org.findByIdAndDelete(req.params.id);
    if (!org) return res.status(404).json({ error: "Organization not found" });
    res.json({ message: "Organization deleted" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/orgs/upload-logo — Upload logo image
router.post("/orgs/upload-logo", upload.single("logo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    // Serve from local uploads folder for now
    // In production: upload to S3 / Cloudflare R2 and return CDN URL
    const url = `${req.protocol}://${req.get("host")}/uploads/logos/${req.file.filename}`;

    if (req.body.orgId && req.body.orgId !== "new") {
      await Org.findByIdAndUpdate(req.body.orgId, { logoUrl: url });
    }

    res.json({ url, filename: req.file.filename });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/orgs/scrape — Scrape company website for AI knowledge
router.post("/orgs/scrape", async (req, res) => {
  const { url, orgId } = req.body;
  if (!url) return res.status(400).json({ error: "URL required" });

  try {
    // Fetch the website
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "HireAxis-Bot/1.0 (AI Interview Knowledge Extraction)",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();

    // Strip HTML → plain text
    const textContent = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim()
      .substring(0, 10000);

    // GPT-4o extracts structured company info
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const extraction = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are a company information extractor. Given raw website text, extract structured information about the company. Return a JSON object with these fields:
- companyInfo: A comprehensive paragraph about what the company does, products/services, size, mission, market position
- benefits: Employee benefits, perks, compensation info (or empty string if not found)
- culture: Company culture, values, work environment info (or empty string if not found)
- keyFacts: Bullet-point list of key facts an interviewer should know

Return ONLY valid JSON, no markdown.`,
        },
        {
          role: "user",
          content: `Extract company information from this website content:\n\n${textContent}`,
        },
      ],
      temperature: 0.3,
      max_tokens: 2000,
    });

    let parsed;
    try {
      const raw = extraction.choices[0].message.content
        .replace(/```json\n?|```/g, "")
        .trim();
      parsed = JSON.parse(raw);
    } catch (e) {
      parsed = {
        companyInfo: textContent.substring(0, 2000),
        benefits: "",
        culture: "",
      };
    }

    // Save to org if id provided
    if (orgId && orgId !== "new") {
      await Org.findByIdAndUpdate(orgId, {
        "aiKnowledge.scrapedContent": textContent.substring(0, 5000),
        "aiKnowledge.lastScraped": new Date(),
      });
    }

    res.json({
      companyInfo: parsed.companyInfo || "",
      benefits: parsed.benefits || "",
      culture: parsed.culture || "",
      keyFacts: parsed.keyFacts || "",
      scrapedLength: textContent.length,
    });
  } catch (e) {
    console.error("Scrape error:", e.message);
    res.status(500).json({ error: `Failed to scrape: ${e.message}` });
  }
});

// GET /api/admin/orgs/:id/ai-context — Get compiled AI context for interviews
router.get("/orgs/:id/ai-context", async (req, res) => {
  try {
    const org = await Org.findById(req.params.id);
    if (!org) return res.status(404).json({ error: "Organization not found" });

    const context = buildAIContext(org);
    res.json({
      context,
      interviewer: org.interviewer,
      branding: {
        name: org.name,
        logoUrl: org.logoUrl,
        website: org.website,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
