const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const puppeteer = require("puppeteer");
const { Parser } = require("json2csv");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "DELETE"],
  allowedHeaders: ["Content-Type"]
}));
app.use(express.json());

// ── In-memory store ──────────────────────────────────────
let scrapeState = {
  status: "idle",       // idle | running | complete | error
  progress: 0,
  total: 0,
  results: [],
  errors: [],
  startTime: null,
};

// ── Helper: emit progress via Socket.io ──────────────────
function emitProgress(current, total, company) {
  const percent = total > 0 ? Math.round((current / total) * 100) : 0;
  const elapsed = (Date.now() - scrapeState.startTime) / 1000;
  const speed = current > 0 ? elapsed / current : 0;
  const remaining = Math.round((total - current) * speed);

  io.emit("progress", {
    current,
    total,
    percent,
    currentCompany: company,
    estimatedSecondsRemaining: remaining,
  });
}

// ── Main scraper function ─────────────────────────────────
async function runScraper(delay = 1500, skipDetails = false) {
  scrapeState = {
    status: "running",
    progress: 0,
    total: 0,
    results: [],
    errors: [],
    startTime: Date.now(),
  };

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--window-size=1280,900",
    ],
  });

  try {
    const page = await browser.newPage();

    // Set user agent
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // ── PHASE 1: Load all listings ──────────────────────
    console.log("Navigating to AppExchange...");
    await page.goto("https://appexchange.salesforce.com/consulting", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await page.waitForSelector(".appx-tile-consultant", { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 3000));

    // Click Show More until gone
    let clickCount = 0;
    while (true) {
      const btn = await page.$("#appx-load-more-button-id");
      if (!btn) break;

      const isVisible = await page.evaluate((el) => {
        const style = window.getComputedStyle(el);
        return style.display !== "none" && style.visibility !== "hidden";
      }, btn);

      if (!isVisible) break;

      clickCount++;
      console.log(`Clicking Show More #${clickCount}...`);
      await btn.evaluate((el) => el.scrollIntoView());
      await btn.click();
      await new Promise((r) => setTimeout(r, 3000));
    }

    // Extract all tile data
    const listings = await page.evaluate(() => {
      const tiles = document.querySelectorAll("a.appx-tile.appx-tile-consultant");
      const seen = new Set();
      const results = [];

      tiles.forEach((tile) => {
        const id = tile.getAttribute("data-listing-id");
        const name = tile.getAttribute("data-listing-name");
        if (id && !seen.has(id)) {
          seen.add(id);
          results.push({
            name: name || "",
            listing_id: id,
            listing_url: `https://appexchange.salesforce.com/appxConsultingListingDetail?listingId=${id}`,
          });
        }
      });

      return results;
    });

    console.log(`Found ${listings.length} listings`);
    scrapeState.total = listings.length;
    io.emit("phase1Complete", { total: listings.length });

    if (skipDetails) {
      // Skip detail pages — just return names + URLs
      scrapeState.results = listings.map((l) => ({
        company_name: l.name,
        website: "",
        phone: "",
        email: "",
        certified_experts: "",
        projects_completed: "",
        rating: "",
        listing_url: l.listing_url,
      }));
      scrapeState.status = "complete";
      scrapeState.progress = listings.length;
      io.emit("complete", { totalScraped: listings.length });
      return;
    }

    // ── PHASE 2: Scrape each detail page ────────────────
    const results = [];

    for (let i = 0; i < listings.length; i++) {
      const listing = listings[i];
      scrapeState.progress = i + 1;
      emitProgress(i + 1, listings.length, listing.name);

      const result = {
        company_name: listing.name,
        website: "",
        phone: "",
        email: "",
        certified_experts: "",
        projects_completed: "",
        rating: "",
        listing_url: listing.listing_url,
      };

      try {
        await page.goto(listing.listing_url, {
          timeout: 30000,
          waitUntil: "domcontentloaded",
        });
        await new Promise((r) => setTimeout(r, delay));

        // Website
        try {
          const webEl = await page.$("a[data-event='listing_website']");
          if (webEl) {
            result.website = await page.evaluate(
              (el) => el.innerText.trim(),
              webEl
            );
          } else {
            const links = await page.$$("a[href^='http']");
            for (const link of links) {
              const href = await page.evaluate(
                (el) => el.getAttribute("href"),
                link
              );
              if (
                href &&
                !href.includes("salesforce.com") &&
                !href.includes("appexchange") &&
                !href.includes("trailblazer")
              ) {
                result.website = href;
                break;
              }
            }
          }
        } catch (_) {}

        // Phone
        try {
          const phoneEl = await page.$("a[href^='tel:']");
          if (phoneEl) {
            result.phone = await page.evaluate(
              (el) => el.innerText.trim(),
              phoneEl
            );
          }
        } catch (_) {}

        // Email
        try {
          const emailEl = await page.$("a[href^='mailto:']");
          if (emailEl) {
            const href = await page.evaluate(
              (el) => el.getAttribute("href"),
              emailEl
            );
            result.email = (href || "").replace("mailto:", "").trim();
          }
        } catch (_) {}

        // Certified Experts + Projects Completed
        try {
          const features = await page.$$(".appx-tile-feature");
          for (const feature of features) {
            const text = await page.evaluate(
              (el) => el.innerText.trim(),
              feature
            );
            const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
            if (
              text.toLowerCase().includes("certified experts") &&
              lines.length >= 2
            ) {
              result.certified_experts = lines[lines.length - 1];
            }
            if (
              text.toLowerCase().includes("projects completed") &&
              lines.length >= 2
            ) {
              result.projects_completed = lines[lines.length - 1];
            }
          }
        } catch (_) {}

        // Rating
        try {
          const ratingEl = await page.$(".appx-rating-amount");
          if (ratingEl) {
            const text = await page.evaluate(
              (el) => el.innerText.trim(),
              ratingEl
            );
            result.rating = text.replace(/[()]/g, "");
          }
        } catch (_) {}
      } catch (err) {
        scrapeState.errors.push({
          company: listing.name,
          error: err.message,
        });
        console.error(`Error scraping ${listing.name}: ${err.message}`);
      }

      results.push(result);
      scrapeState.results = results;
    }

    scrapeState.status = "complete";
    io.emit("complete", {
      totalScraped: results.length,
      totalErrors: scrapeState.errors.length,
    });
    console.log("Scraping complete!");
  } catch (err) {
    scrapeState.status = "error";
    io.emit("error", { message: err.message });
    console.error("Scraper error:", err.message);
  } finally {
    await browser.close();
  }
}

// ── API Routes ────────────────────────────────────────────

// Start scraping
app.post("/api/scrape/start", async (req, res) => {
  if (scrapeState.status === "running") {
    return res.json({ message: "Already running", status: "running" });
  }
  const delay = req.body.delay || 1500;
  const skipDetails = req.body.skipDetails || false;

  // Run in background
  runScraper(delay, skipDetails).catch(console.error);

  res.json({ message: "Scraper started", status: "started" });
});

// Get status
app.get("/api/scrape/status", (req, res) => {
  res.json({
    status: scrapeState.status,
    progress: scrapeState.progress,
    total: scrapeState.total,
    percent:
      scrapeState.total > 0
        ? Math.round((scrapeState.progress / scrapeState.total) * 100)
        : 0,
    resultsCount: scrapeState.results.length,
    errorsCount: scrapeState.errors.length,
  });
});

// Get paginated results
app.get("/api/scrape/results", (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 100;
  const search = req.query.search || "";

  let filtered = scrapeState.results;

  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter(
      (r) =>
        r.company_name.toLowerCase().includes(q) ||
        r.website.toLowerCase().includes(q) ||
        r.email.toLowerCase().includes(q)
    );
  }

  const start = (page - 1) * limit;
  const paginated = filtered.slice(start, start + limit);

  res.json({
    page,
    limit,
    total: filtered.length,
    totalPages: Math.ceil(filtered.length / limit),
    hasMore: start + limit < filtered.length,
    data: paginated,
  });
});

// Download CSV
app.get("/api/scrape/results/download", (req, res) => {
  try {
    const fields = [
      "company_name",
      "website",
      "phone",
      "email",
      "certified_experts",
      "projects_completed",
      "rating",
      "listing_url",
    ];
    const parser = new Parser({ fields });
    const csv = parser.parse(scrapeState.results);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=appexchange_consultants.csv"
    );
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reset
app.delete("/api/scrape/reset", (req, res) => {
  scrapeState = {
    status: "idle",
    progress: 0,
    total: 0,
    results: [],
    errors: [],
    startTime: null,
  };
  res.json({ message: "Reset complete" });
});

// Socket.io connection
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);
  // Send current state on connect
  socket.emit("currentState", {
    status: scrapeState.status,
    progress: scrapeState.progress,
    total: scrapeState.total,
  });
});

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});