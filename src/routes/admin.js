// ═══════════════════════════════════════════════════════════════
// HIREAXIS ADMIN ROUTES v2 — /api/admin/*
// Enhanced: brand extraction, slug routing, full white-label
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

// ─── Organization Schema (enhanced with branding) ───
const orgSchema = new mongoose.Schema({
  name: { type: String, required: true },
  slug: { type: String, unique: true, lowercase: true }, // e.g. "coca-cola"
  website: String,
  about: String,
  industry: String,
  logoUrl: String,

  // Brand identity — auto-detected + manual overrides
  brand: {
    primaryColor: { type: String, default: "#4f46e5" },
    accentColor: { type: String, default: "#10b981" },
    backgroundColor: { type: String, default: "#08090e" },
    textColor: { type: String, default: "#f0f0f8" },
    fontFamily: { type: String, default: "" }, // empty = auto-detect
    fontUrl: String, // Google Fonts URL if custom
    favicon: String,
    ogImage: String, // Open Graph social image
    autoDetected: { type: Boolean, default: false },
    // Manual overrides (if set, these take priority over auto-detected)
    overrides: {
      primaryColor: String,
      accentColor: String,
      backgroundColor: String,
      fontFamily: String,
    },
  },

  // AI Interviewer persona
  interviewer: {
    name: { type: String, default: "Hiring Manager" },
    avatarUrl: String,
    personality: {
      type: String,
      default:
        "Professional, warm, and encouraging. Asks follow-up questions naturally.",
    },
  },

  // Interview channels
  channels: {
    web: { type: Boolean, default: true },
    phone: { type: Boolean, default: false },
    embed: { type: Boolean, default: false },
    phoneNumber: String,
  },

  // AI Knowledge base
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
  // Auto-generate slug from name if not set
  if (!this.slug && this.name) {
    this.slug = this.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }
  next();
});

const Org =
  mongoose.models.Organization ||
  mongoose.model("Organization", orgSchema);

// ─── Auth middleware ───
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer "))
    return res.status(401).json({ error: "Unauthorized" });
  try {
    const decoded = jwt.verify(auth.split(" ")[1], JWT_SECRET);
    if (decoded.role !== "admin" && decoded.role !== "super_admin") {
      return res.status(403).json({ error: "Admin access required" });
    }
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// ─── Logo upload ───
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
// BRAND EXTRACTION — scrapes CSS, meta tags, fonts
// ═══════════════════════════════════════════

function extractBrandFromHTML(html, url) {
  const brand = {
    primaryColor: null,
    accentColor: null,
    backgroundColor: null,
    fontFamily: null,
    fontUrl: null,
    favicon: null,
    ogImage: null,
  };

  // 1. Extract favicon
  const faviconMatch =
    html.match(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']+)["']/i) ||
    html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'](?:shortcut )?icon["']/i);
  if (faviconMatch) {
    brand.favicon = resolveUrl(faviconMatch[1], url);
  }

  // 2. Extract OG image
  const ogMatch =
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (ogMatch) {
    brand.ogImage = resolveUrl(ogMatch[1], url);
  }

  // 3. Extract theme-color meta tag (often the brand color)
  const themeColorMatch =
    html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']theme-color["']/i);
  if (themeColorMatch) {
    brand.primaryColor = themeColorMatch[1];
  }

  // 4. Extract Google Fonts URL
  const fontMatch = html.match(
    /href=["'](https:\/\/fonts\.googleapis\.com\/css2?\?[^"']+)["']/i
  );
  if (fontMatch) {
    brand.fontUrl = fontMatch[1];
    // Extract font family name from the URL
    const familyMatch = fontMatch[1].match(/family=([^&:+]+)/);
    if (familyMatch) {
      brand.fontFamily = decodeURIComponent(familyMatch[1]).replace(/\+/g, " ");
    }
  }

  // 5. Extract colors from CSS custom properties (--primary, --brand, etc.)
  const cssVarColors = [];
  const cssVarRegex =
    /--(?:primary|brand|main|accent|theme|color-primary|color-brand)[^:]*:\s*(#[0-9a-fA-F]{3,8}|rgb[a]?\([^)]+\))/gi;
  let match;
  while ((match = cssVarRegex.exec(html)) !== null) {
    cssVarColors.push(match[1]);
  }
  if (cssVarColors.length > 0 && !brand.primaryColor) {
    brand.primaryColor = cssVarColors[0];
  }
  if (cssVarColors.length > 1) {
    brand.accentColor = cssVarColors[1];
  }

  // 6. Extract background color from body/main CSS
  const bgMatch = html.match(
    /(?:body|main|\.app|#app|#root)\s*\{[^}]*background(?:-color)?:\s*(#[0-9a-fA-F]{3,8}|rgb[a]?\([^)]+\))/i
  );
  if (bgMatch) {
    brand.backgroundColor = bgMatch[1];
  }

  // 7. Extract font-family from body CSS
  if (!brand.fontFamily) {
    const bodyFontMatch = html.match(
      /(?:body|html)\s*\{[^}]*font-family:\s*["']?([^;"'}\n]+)/i
    );
    if (bodyFontMatch) {
      const rawFont = bodyFontMatch[1].trim().split(",")[0].replace(/['"]/g, "").trim();
      // Filter out generic fonts
      if (!["arial", "helvetica", "sans-serif", "serif", "monospace", "system-ui", "-apple-system"].includes(rawFont.toLowerCase())) {
        brand.fontFamily = rawFont;
      }
    }
  }

  // 8. Fallback: extract most common hex colors from inline styles
  if (!brand.primaryColor) {
    const allColors = {};
    const hexRegex = /#([0-9a-fA-F]{6})\b/g;
    let colorMatch;
    while ((colorMatch = hexRegex.exec(html)) !== null) {
      const hex = `#${colorMatch[1]}`;
      // Skip very light, very dark, grays, white, black
      if (isNeutralColor(hex)) continue;
      allColors[hex] = (allColors[hex] || 0) + 1;
    }
    const sorted = Object.entries(allColors).sort((a, b) => b[1] - a[1]);
    if (sorted.length > 0) brand.primaryColor = sorted[0][0];
    if (sorted.length > 1) brand.accentColor = sorted[1][0];
  }

  return brand;
}

function resolveUrl(href, baseUrl) {
  if (!href) return null;
  if (href.startsWith("http")) return href;
  if (href.startsWith("//")) return "https:" + href;
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return href;
  }
}

function isNeutralColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Check if gray (r ≈ g ≈ b)
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  if (spread < 20) return true;
  // Check if too light or too dark
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  if (brightness > 240 || brightness < 15) return true;
  return false;
}

// ═══════════════════════════════════════════
// BUILD AI CONTEXT
// ═══════════════════════════════════════════

function buildAIContext(org) {
  const sections = [];
  sections.push(`You are an AI interviewer representing ${org.name}.`);
  if (org.interviewer?.personality)
    sections.push(`PERSONALITY: ${org.interviewer.personality}`);
  if (org.interviewer?.name)
    sections.push(`Your name is ${org.interviewer.name}. Introduce yourself by this name.`);
  if (org.about) sections.push(`ABOUT ${org.name.toUpperCase()}:\n${org.about}`);
  if (org.aiKnowledge?.companyInfo)
    sections.push(`COMPANY INFORMATION:\n${org.aiKnowledge.companyInfo}`);
  if (org.aiKnowledge?.benefits)
    sections.push(`BENEFITS & PERKS:\n${org.aiKnowledge.benefits}`);
  if (org.aiKnowledge?.culture)
    sections.push(`CULTURE & VALUES:\n${org.aiKnowledge.culture}`);
  if (org.aiKnowledge?.faq)
    sections.push(`FREQUENTLY ASKED QUESTIONS:\n${org.aiKnowledge.faq}`);
  if (org.website) sections.push(`Company website: ${org.website}`);
  sections.push(`
CRITICAL RULES:
- You represent ${org.name} ONLY. Never mention "HireAxis" or any other company name as your employer or platform.
- If candidates ask who made this interview system, say "${org.name} uses an AI-powered interview platform" without naming it.
- If candidates want to reschedule or have issues, tell them to contact the ${org.name} hiring team directly.
- Answer candidate questions about ${org.name} naturally using the info above.
- If asked something not covered, say you'll connect them with the ${org.name} hiring team for specifics.
- Never invent facts about ${org.name}. Be conversational, enthusiastic but honest.
- You work for ${org.name}. You are part of the ${org.name} team. Act accordingly.`);
  return sections.join("\n\n");
}

// ═══════════════════════════════════════════
// PROTECTED ROUTES (require admin)
// ═══════════════════════════════════════════

// Apply admin auth to all routes below
router.use(requireAdmin);

// GET /api/admin/orgs
router.get("/orgs", async (req, res) => {
  try {
    const orgs = await Org.find().sort({ createdAt: -1 });
    res.json({ orgs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/orgs/:id
router.get("/orgs/:id", async (req, res) => {
  try {
    const org = await Org.findById(req.params.id);
    if (!org) return res.status(404).json({ error: "Not found" });
    res.json(org);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/orgs
router.post("/orgs", async (req, res) => {
  try {
    const org = new Org(req.body);
    await org.save();
    res.status(201).json(org);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// PUT /api/admin/orgs/:id
router.put("/orgs/:id", async (req, res) => {
  try {
    const org = await Org.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!org) return res.status(404).json({ error: "Not found" });
    res.json(org);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/admin/orgs/:id
router.delete("/orgs/:id", async (req, res) => {
  try {
    await Org.findByIdAndDelete(req.params.id);
    res.json({ message: "Deleted" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/orgs/upload-logo
router.post("/orgs/upload-logo", upload.single("logo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file" });
    const url = `${req.protocol}://${req.get("host")}/uploads/logos/${req.file.filename}`;
    if (req.body.orgId && req.body.orgId !== "new") {
      await Org.findByIdAndUpdate(req.body.orgId, { logoUrl: url });
    }
    res.json({ url, filename: req.file.filename });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/orgs/scrape — Enhanced: extracts brand + content
router.post("/orgs/scrape", async (req, res) => {
  const { url, orgId } = req.body;
  if (!url) return res.status(400).json({ error: "URL required" });

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; HireAxis/1.0)",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();

    // ─── Extract brand identity ───
    const brand = extractBrandFromHTML(html, url);

    // ─── Extract text content ───
    const textContent = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .trim()
      .substring(0, 10000);

    // ─── GPT-4o structured extraction ───
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const extraction = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You extract company information from website text. Return ONLY a JSON object:
{
  "companyInfo": "Comprehensive paragraph: what the company does, products/services, size, mission, market position, founding year, headquarters",
  "benefits": "Employee benefits, perks, compensation mentioned (empty string if none found)",
  "culture": "Company culture, values, work environment, diversity initiatives (empty string if none found)",
  "faq": "Generate 5-8 Q&A pairs a job candidate might ask, based on the company info. Format: Q: question\\nA: answer\\n\\n"
}
No markdown, no backticks, just JSON.`,
        },
        {
          role: "user",
          content: textContent,
        },
      ],
      temperature: 0.3,
      max_tokens: 2500,
    });

    let parsed;
    try {
      parsed = JSON.parse(
        extraction.choices[0].message.content.replace(/```json\n?|```/g, "").trim()
      );
    } catch {
      parsed = { companyInfo: textContent.substring(0, 2000), benefits: "", culture: "", faq: "" };
    }

    // Save to org if id provided
    if (orgId && orgId !== "new") {
      const update = {
        "aiKnowledge.scrapedContent": textContent.substring(0, 5000),
        "aiKnowledge.lastScraped": new Date(),
        "brand.autoDetected": true,
      };
      // Only set brand values if auto-detected (don't overwrite manual overrides)
      if (brand.primaryColor) update["brand.primaryColor"] = brand.primaryColor;
      if (brand.accentColor) update["brand.accentColor"] = brand.accentColor;
      if (brand.backgroundColor) update["brand.backgroundColor"] = brand.backgroundColor;
      if (brand.fontFamily) update["brand.fontFamily"] = brand.fontFamily;
      if (brand.fontUrl) update["brand.fontUrl"] = brand.fontUrl;
      if (brand.favicon) update["brand.favicon"] = brand.favicon;
      if (brand.ogImage) update["brand.ogImage"] = brand.ogImage;

      await Org.findByIdAndUpdate(orgId, update);
    }

    res.json({
      companyInfo: parsed.companyInfo || "",
      benefits: parsed.benefits || "",
      culture: parsed.culture || "",
      faq: parsed.faq || "",
      brand, // Return detected brand to frontend for preview
      scrapedLength: textContent.length,
    });
  } catch (e) {
    console.error("Scrape error:", e.message);
    res.status(500).json({ error: `Scrape failed: ${e.message}` });
  }
});

// ═══════════════════════════════════════════
// PUBLIC ROUTES — No auth needed
// These are called by the candidate portal
// ═══════════════════════════════════════════

// Create a separate router for public endpoints
const publicRouter = Router();

// GET /api/org/:slug — Public: get org branding + config by slug
publicRouter.get("/org/:slug", async (req, res) => {
  try {
    const org = await Org.findOne({ slug: req.params.slug, status: "active" });
    if (!org) return res.status(404).json({ error: "Organization not found" });

    // Return only what the candidate portal needs (no sensitive data)
    const effectiveBrand = {
      primaryColor: org.brand?.overrides?.primaryColor || org.brand?.primaryColor || "#4f46e5",
      accentColor: org.brand?.overrides?.accentColor || org.brand?.accentColor || "#10b981",
      backgroundColor: org.brand?.overrides?.backgroundColor || org.brand?.backgroundColor || "#08090e",
      textColor: org.brand?.textColor || "#f0f0f8",
      fontFamily: org.brand?.overrides?.fontFamily || org.brand?.fontFamily || "",
      fontUrl: org.brand?.fontUrl || "",
      favicon: org.brand?.favicon || "",
    };

    res.json({
      name: org.name,
      slug: org.slug,
      logoUrl: org.logoUrl,
      website: org.website,
      industry: org.industry,
      brand: effectiveBrand,
      interviewer: {
        name: org.interviewer?.name || "Hiring Manager",
        avatarUrl: org.interviewer?.avatarUrl || "",
      },
      channels: {
        web: org.channels?.web !== false,
        phone: org.channels?.phone || false,
        phoneNumber: org.channels?.phoneNumber || "",
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/org/:slug/ai-context — Public: compiled AI knowledge for interviews
publicRouter.get("/org/:slug/ai-context", async (req, res) => {
  try {
    const org = await Org.findOne({ slug: req.params.slug });
    if (!org) return res.status(404).json({ error: "Not found" });
    res.json({
      context: buildAIContext(org),
      interviewer: org.interviewer,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/org/:slug/roles — Public: active roles for this org
publicRouter.get("/org/:slug/roles", async (req, res) => {
  try {
    const org = await Org.findOne({ slug: req.params.slug });
    if (!org) return res.json({ roles: [] });

    // Find roles linked to this org's company
    const Role = mongoose.models.Role;
    if (!Role || !org.companyId) return res.json({ roles: [] });

    const roles = await Role.find({ companyId: org.companyId, status: "active" })
      .select("title department channel maxDurationMinutes")
      .sort({ title: 1 });
    res.json({ roles });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
export { publicRouter };
