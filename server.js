const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json({ limit: "100kb" }));

app.get("/admin.html", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BOT_TOKEN = process.env.BOT_TOKEN;

const FRONTEND_URL = (
  process.env.FRONTEND_URL ||
  "https://fc-points-miniapp.onrender.com"
).trim().replace(/\/+$/, "");

const ADMIN_TELEGRAM_ID = String(process.env.ADMIN_TELEGRAM_ID || "");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !BOT_TOKEN) {
  console.error("Missing required environment variables.");
  process.exit(1);
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);

const DAILY_MAX = 650;
const NORMAL_MAX = 200;
const CHECKIN_REWARD = 10;
const DAILY_TASK_REWARD = 20;

const BADGES = {
  blueberry: { name: "Blueberry", price: 5000 },
  green_berry: { name: "Green Berry", price: 10000 },
  blue_tick: { name: "Verified Blue Tick", price: 15000 },
  black_vip: { name: "Black VIP", price: 25000 }
};

/* CORS */

app.use((req, res, next) => {
  const origin = String(req.headers.origin || "")
    .trim()
    .replace(/\/+$/, "");

  const allowedOrigins = [
    FRONTEND_URL,
    "https://fc-points-miniapp.onrender.com",
    "https://found-points-app.onrender.com"
  ];

  const originAllowed = allowedOrigins.includes(origin);

  console.log(
    "[CORS]",
    req.method,
    req.path,
    "origin=",
    origin || "(none)",
    "allowed=",
    originAllowed
  );

  if (originAllowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Telegram-Init-Data, X-Admin-Id, X-Admin-Password"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PATCH, DELETE, OPTIONS"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

/* Bangladesh local date */

function today() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const values = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  return `${values.year}-${values.month}-${values.day}`;
}

function fail(res, status, message) {
  return res.status(status).json({ error: message });
}

async function db(table, query) {
  const result = await query;

  if (result.error) {
    console.error(`[DATABASE ERROR: ${table}]`, result.error);
    throw new Error(
      `Database operation failed: ${table} — ${result.error.message}`
    );
  }

  return result.data;
}

function verifyTelegramInitData(initData) {
  if (!initData || typeof initData !== "string") return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");

  if (!hash) return null;

  params.delete("hash");

  const pairs = [];

  for (const [key, value] of params.entries()) {
    pairs.push(`${key}=${value}`);
  }

  pairs.sort();

  const dataCheckString = pairs.join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();

  const expectedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  const a = Buffer.from(expectedHash, "hex");
  const b = Buffer.from(hash, "hex");

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return null;
  }

  const authDate = Number(params.get("auth_date") || 0);
  const now = Math.floor(Date.now() / 1000);

  if (!authDate || now - authDate > 86400 || authDate > now + 60) {
    return null;
  }

  try {
    const user = JSON.parse(params.get("user") || "{}");

    if (!user.id) return null;

    return user;
  } catch {
    return null;
  }
}

function telegramAuth(req, res, next) {
  const initData =
    req.get("X-Telegram-Init-Data") || req.body?.initData;

  const user = verifyTelegramInitData(initData);

  if (!user) {
    return fail(
      res,
      401,
      "Telegram পরিচয় যাচাই করা যায়নি। Telegram Mini App থেকে খুলুন।"
    );
  }

  req.telegramUser = user;
  next();
}

function adminAuth(req, res, next) {
  const id = String(req.get("X-Admin-Id") || "");
  const password = String(req.get("X-Admin-Password") || "");

  if (
    !ADMIN_TELEGRAM_ID ||
    !ADMIN_PASSWORD ||
    id !== ADMIN_TELEGRAM_ID ||
    password !== ADMIN_PASSWORD
  ) {
    return fail(res, 403, "Admin access denied.");
  }

  next();
}

async function getUser(telegramId) {
  return db(
    "users",
    supabase
      .from("users")
      .select("*")
      .eq("telegram_id", String(telegramId))
      .maybeSingle()
  );
}

async function ensureUser(tg) {
  let user = await getUser(tg.id);

  if (user) {
    if (user.is_blocked) {
      throw new Error("এই অ্যাকাউন্টটি ব্লক করা হয়েছে।");
    }

    return user;
  }

  return db(
    "users",
    supabase
      .from("users")
      .insert({
        telegram_id: String(tg.id),
        username: tg.username || null,
        first_name: tg.first_name || "User",
        display_name: tg.first_name || "User",
        balance: 0,
        is_blocked: false,
        created_at: new Date().toISOString()
      })
      .select("*")
      .single()
  );
}

async function getOrCreateActivity(telegramId) {
  let row = await db(
    "daily_activity",
    supabase
      .from("daily_activity")
      .select("*")
      .eq("telegram_id", String(telegramId))
      .eq("activity_date", today())
      .maybeSingle()
  );

  if (!row) {
    row = await db(
      "daily_activity",
      supabase
        .from("daily_activity")
        .insert({
          telegram_id: String(telegramId),
          activity_date: today(),
          normal_earned: 0,
          total_earned: 0,
          daily_task_claimed: false,
          checkin_claimed: false
        })
        .select("*")
        .single()
    );
  }

  return row;
}

async function addTransaction(
  telegramId,
  amount,
  type,
  description,
  reference = null
) {
  return db(
    "transactions",
    supabase.from("transactions").insert({
      telegram_id: String(telegramId),
      amount,
      type,
      description,
      reference_id: reference,
      created_at: new Date().toISOString()
    })
  );
}

async function addPoints(telegramId, amount, type, description) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error("Invalid reward amount.");
  }

  const user = await getUser(telegramId);

  if (!user || user.is_blocked) {
    throw new Error("User unavailable.");
  }

  const activity = await getOrCreateActivity(telegramId);

  if (Number(activity.total_earned || 0) + amount > DAILY_MAX) {
    throw new Error("আজকের 650 FP দৈনিক সীমা পূর্ণ হয়েছে।");
  }

  const newBalance = Number(user.balance || 0) + amount;

  await db(
    "users",
    supabase
      .from("users")
      .update({
        balance: newBalance,
        updated_at: new Date().toISOString()
      })
      .eq("telegram_id", String(telegramId))
  );

  await db(
    "daily_activity",
    supabase
      .from("daily_activity")
      .update({
        total_earned: Number(activity.total_earned || 0) + amount
      })
      .eq("telegram_id", String(telegramId))
      .eq("activity_date", today())
  );

  await addTransaction(telegramId, amount, type, description);

  return { balance: newBalance, awarded: amount };
}

/* HEALTH CHECK */

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "FP Points Backend",
    version: "fp-2.1"
  });
});

app.get("/health/db", async (req, res) => {
  try {
    await db(
      "users",
      supabase.from("users").select("id").limit(1)
    );

    res.json({ status: "ok", database: "connected" });
  } catch (e) {
    console.error("[HEALTH DB]", e);

    res.status(503).json({
      status: "error",
      database: "unavailable"
    });
  }
});

/* REGISTRATION */

app.post("/api/register", async (req, res) => {
  try {
    const tg = verifyTelegramInitData(req.body?.initData);

    if (!tg) return fail(res, 401, "Invalid Telegram initData.");

    const user = await ensureUser(tg);

    res.json({
      success: true,
      user: {
        telegram_id: user.telegram_id,
        balance: user.balance,
        display_name: user.display_name
      }
    });
  } catch (e) {
    console.error("[REGISTER ERROR]", e);
    fail(res, 400, e.message);
  }
});

/* USER PROFILE */

app.get("/api/user", telegramAuth, async (req, res) => {
  try {
    const user = await ensureUser(req.telegramUser);
    const activity = await getOrCreateActivity(user.telegram_id);

    const badges = await db(
      "user_badges",
      supabase
        .from("user_badges")
        .select("badge_key")
        .eq("telegram_id", String(user.telegram_id))
    );

    res.json({
      user: {
        ...user,
        todayEarned: Number(activity.total_earned || 0),
        normal_earned_today: Number(activity.normal_earned || 0),
        badges: (badges || []).map((b) => ({
          key: b.badge_key,
          name: BADGES[b.badge_key]?.name || b.badge_key
        }))
      }
    });
  } catch (e) {
    console.error("[USER PROFILE ERROR]", e);
    fail(res, 400, e.message);
  }
});

app.patch(
  "/api/profile/display-name",
  telegramAuth,
  async (req, res) => {
    try {
      const displayName = String(req.body?.displayName || "").trim();

      if (!displayName || displayName.length > 40) {
        return fail(res, 400, "নাম ১ থেকে ৪০ অক্ষরের মধ্যে হতে হবে।");
      }

      await ensureUser(req.telegramUser);

      const user = await db(
        "users",
        supabase
          .from("users")
          .update({
            display_name: displayName,
            updated_at: new Date().toISOString()
          })
          .eq("telegram_id", String(req.telegramUser.id))
          .select("*")
          .single()
      );

      res.json({ success: true, user });
    } catch (e) {
      console.error("[PROFILE NAME ERROR]", e);
      fail(res, 400, e.message);
    }
  }
);

/* NORMAL EARNING */

app.post("/api/earning/start", telegramAuth, async (req, res) => {
  try {
    const user = await ensureUser(req.telegramUser);
    const activity = await getOrCreateActivity(user.telegram_id);

    res.json({
      success: true,
      normalEarnedToday: Number(activity.normal_earned || 0),
      remaining: Math.max(
        0,
        NORMAL_MAX - Number(activity.normal_earned || 0)
      )
    });
  } catch (e) {
    console.error("[EARNING START ERROR]", e);
    fail(res, 400, e.message);
  }
});

app.post("/api/earning/claim", telegramAuth, async (req, res) => {
  try {
    const user = await ensureUser(req.telegramUser);
    const activity = await getOrCreateActivity(user.telegram_id);

    if (Number(activity.normal_earned || 0) >= NORMAL_MAX) {
      return fail(res, 400, "Normal earning daily limit reached.");
    }

    if (Number(activity.total_earned || 0) >= DAILY_MAX) {
      return fail(res, 400, "Daily earning limit reached.");
    }

    const reward = 1;

    const result = await addPoints(
      user.telegram_id,
      reward,
      "normal_earning",
      "Normal earning"
    );

    await db(
      "daily_activity",
      supabase
        .from("daily_activity")
        .update({
          normal_earned: Number(activity.normal_earned || 0) + reward
        })
        .eq("telegram_id", String(user.telegram_id))
        .eq("activity_date", today())
    );

    console.log("[EARNING CLAIM SUCCESS]", {
      telegramId: String(user.telegram_id),
      awarded: result.awarded,
      balance: result.balance
    });

    res.json({
      success: true,
      awarded: result.awarded,
      balance: result.balance,
      normalEarnedToday: Number(activity.normal_earned || 0) + reward
    });
  } catch (e) {
    console.error("[EARNING CLAIM ERROR]", e);
    fail(res, 400, e.message);
  }
});

/* CHECK-IN */

app.post("/api/checkin", telegramAuth, async (req, res) => {
  try {
    const user = await ensureUser(req.telegramUser);
    const activity = await getOrCreateActivity(user.telegram_id);

    if (activity.checkin_claimed) {
      return fail(res, 400, "আজকের চেক-ইন ইতিমধ্যে নেওয়া হয়েছে।");
    }

    if (Number(activity.total_earned || 0) + CHECKIN_REWARD > DAILY_MAX) {
      return fail(res, 400, "আজকের দৈনিক সীমা পূর্ণ হয়েছে।");
    }

    const result = await addPoints(
      user.telegram_id,
      CHECKIN_REWARD,
      "daily_checkin",
      "Daily check-in"
    );

    await db(
      "daily_activity",
      supabase
        .from("daily_activity")
        .update({ checkin_claimed: true })
        .eq("telegram_id", String(user.telegram_id))
        .eq("activity_date", today())
    );

    res.json({
      success: true,
      awarded: result.awarded,
      balance: result.balance
    });
  } catch (e) {
    console.error("[CHECKIN ERROR]", e);
    fail(res, 400, e.message);
  }
});

app.get("/api/tasks/status", telegramAuth, async (req, res) => {
  try {
    const user = await ensureUser(req.telegramUser);
    const activity = await getOrCreateActivity(user.telegram_id);

    res.json({
      checkinClaimed: Boolean(activity.checkin_claimed),
      dailyTaskCompleted: Boolean(activity.daily_task_claimed),
      normalEarnedToday: Number(activity.normal_earned || 0),
      todayEarned: Number(activity.total_earned || 0),
      dailyMaximum: DAILY_MAX
    });
  } catch (e) {
    console.error("[TASK STATUS ERROR]", e);
    fail(res, 400, e.message);
  }
});

/* TRANSACTION HISTORY */

app.get("/api/transactions", telegramAuth, async (req, res) => {
  try {
    const rows = await db(
      "transactions",
      supabase
        .from("transactions")
        .select("*")
        .eq("telegram_id", String(req.telegramUser.id))
        .order("created_at", { ascending: false })
        .limit(50)
    );

    res.json({ transactions: rows || [] });
  } catch (e) {
    console.error("[TRANSACTIONS ERROR]", e);
    fail(res, 400, e.message);
  }
});

/* USER: ADMIN MESSAGES */

app.get("/api/messages", telegramAuth, async (req, res) => {
  try {
    const messages = await db(
      "admin_messages",
      supabase
        .from("admin_messages")
        .select("id,title,message,created_at,target_telegram_id")
        .eq("active", true)
        .or(
          `target_telegram_id.is.null,target_telegram_id.eq.${String(
            req.telegramUser.id
          )}`
        )
        .order("created_at", { ascending: false })
        .limit(100)
    );

    res.json({ messages: messages || [] });
  } catch (e) {
    console.error("[MESSAGES LIST ERROR]", e);
    fail(res, 400, e.message);
  }
});

/* SOCIAL TASKS */

app.get("/api/social-tasks", telegramAuth, async (req, res) => {
  try {
    const tasks = await db(
      "social_tasks",
      supabase
        .from("social_tasks")
        .select("*")
        .eq("enabled", true)
        .order("created_at", { ascending: false })
    );

    res.json({ tasks: tasks || [] });
  } catch (e) {
    console.error("[SOCIAL TASKS ERROR]", e);
    fail(res, 400, e.message);
  }
});

app.post("/api/social-tasks/claim", telegramAuth, async (req, res) => {
  let reservedClaim = false;
  let taskId = "";
  let telegramId = "";

  try {
    const user = await ensureUser(req.telegramUser);
    telegramId = String(user.telegram_id);
    taskId = String(req.body?.taskId || "");

    if (!taskId) return fail(res, 400, "Task ID required.");

    const task = await db(
      "social_tasks",
      supabase
        .from("social_tasks")
        .select("*")
        .eq("id", taskId)
        .eq("enabled", true)
        .maybeSingle()
    );

    if (!task) return fail(res, 404, "Task not found.");

    if (task.platform !== "telegram" || !task.channel_username) {
      return fail(res, 400, "এই টাস্কের নির্ভরযোগ্য যাচাই সেটআপ করা হয়নি।");
    }

    const already = await db(
      "social_task_claims",
      supabase
        .from("social_task_claims")
        .select("id")
        .eq("task_id", taskId)
        .eq("telegram_id", telegramId)
        .maybeSingle()
    );

    if (already) {
      return fail(res, 400, "এই টাস্কের পুরস্কার আগেই নেওয়া হয়েছে।");
    }

    const url =
      "https://api.telegram.org/bot" +
      BOT_TOKEN +
      "/getChatMember?chat_id=" +
      encodeURIComponent(task.channel_username) +
      "&user_id=" +
      encodeURIComponent(telegramId);

    const check = await fetch(url);
    const result = await check.json();

    if (!result.ok) {
      return fail(res, 400, "চ্যানেল সদস্যতা যাচাই করা যায়নি।");
    }

    const status = result.result?.status;
    const member =
      ["creator", "administrator", "member"].includes(status) ||
      (status === "restricted" && result.result?.is_member === true);

    if (!member) {
      return fail(res, 400, "পুরস্কারের আগে Telegram চ্যানেলে যোগ দিন।");
    }

    const reward = Number(task.reward || 0);

    if (!Number.isInteger(reward) || reward < 1) {
      return fail(res, 400, "Invalid task reward.");
    }

    const activity = await getOrCreateActivity(telegramId);

    if (Number(activity.total_earned || 0) + reward > DAILY_MAX) {
      return fail(res, 400, "আজকের দৈনিক সীমা পূর্ণ হয়েছে।");
    }

    await db(
      "social_task_claims",
      supabase.from("social_task_claims").insert({
        task_id: taskId,
        telegram_id: telegramId,
        claimed_at: new Date().toISOString()
      })
    );

    reservedClaim = true;

    let resultPoints;

    try {
      resultPoints = await addPoints(
        telegramId,
        reward,
        "social_task",
        "Social task: " + String(task.title || taskId)
      );
    } catch (rewardError) {
      await db(
        "social_task_claims",
        supabase
          .from("social_task_claims")
          .delete()
          .eq("task_id", taskId)
          .eq("telegram_id", telegramId)
      );

      reservedClaim = false;
      throw rewardError;
    }

    res.json({
      success: true,
      awarded: resultPoints.awarded,
      balance: resultPoints.balance
    });
  } catch (e) {
    console.error("[SOCIAL TASK CLAIM ERROR]", e);

    if (reservedClaim && taskId && telegramId) {
      try {
        await db(
          "social_task_claims",
          supabase
            .from("social_task_claims")
            .delete()
            .eq("task_id", taskId)
            .eq("telegram_id", telegramId)
        );
      } catch (cleanupError) {
        console.error("[SOCIAL TASK CLAIM CLEANUP ERROR]", cleanupError);
      }
    }

    fail(res, 400, e.message);
  }
});

/* BADGE SHOP */

app.post("/api/shop/request", telegramAuth, async (req, res) => {
  try {
    const user = await ensureUser(req.telegramUser);
    const badgeKey = String(req.body?.badge || "");
    const badge = BADGES[badgeKey];

    if (!badge) return fail(res, 400, "Unknown badge.");

    const existing = await db(
      "shop_requests",
      supabase
        .from("shop_requests")
        .select("id")
        .eq("telegram_id", String(user.telegram_id))
        .eq("badge_key", badgeKey)
        .eq("status", "pending")
        .maybeSingle()
    );

    if (existing) {
      return fail(res, 400, "এই ব্যাজের অনুরোধ ইতিমধ্যে অপেক্ষমাণ।");
    }

    if (Number(user.balance || 0) < badge.price) {
      return fail(res, 400, "পর্যাপ্ত FP Points নেই।");
    }

    const request = await db(
      "shop_requests",
      supabase
        .from("shop_requests")
        .insert({
          telegram_id: String(user.telegram_id),
          badge_key: badgeKey,
          price: badge.price,
          status: "pending",
          created_at: new Date().toISOString()
        })
        .select("*")
        .single()
    );

    res.json({ success: true, request });
  } catch (e) {
    console.error("[SHOP REQUEST ERROR]", e);
    fail(res, 400, e.message);
  }
});

/* REFERRALS */

app.get("/api/referral", telegramAuth, async (req, res) => {
  try {
    const user = await ensureUser(req.telegramUser);

    const botInfoResponse = await fetch(
      "https://api.telegram.org/bot" + BOT_TOKEN + "/getMe"
    );

    const botInfo = await botInfoResponse.json();

    if (!botInfo.ok) {
      return fail(res, 503, "Bot information unavailable.");
    }

    const rows = await db(
      "referrals",
      supabase
        .from("referrals")
        .select("id")
        .eq("referrer_telegram_id", String(user.telegram_id))
        .eq("status", "confirmed")
    );

    res.json({
      link: `https://t.me/${botInfo.result.username}?start=${user.telegram_id}`,
      successfulReferrals: (rows || []).length
    });
  } catch (e) {
    console.error("[REFERRAL ERROR]", e);
    fail(res, 400, e.message);
  }
});

/* WITHDRAWALS */

app.post("/api/withdrawals", telegramAuth, async (req, res) => {
  try {
    const user = await ensureUser(req.telegramUser);
    const amount = Number(req.body?.amount);
    const method = String(req.body?.method || "");
    const account = String(req.body?.account || "").trim();

    if (!Number.isInteger(amount) || amount < 20000) {
      return fail(res, 400, "Minimum withdrawal is 20,000 FP.");
    }

    if (!["bKash", "Nagad", "Binance"].includes(method)) {
      return fail(res, 400, "Unsupported withdrawal method.");
    }

    if (!account || account.length > 100) {
      return fail(res, 400, "Invalid payout account.");
    }

    if (Number(user.balance || 0) < amount) {
      return fail(res, 400, "পর্যাপ্ত ব্যালেন্স নেই।");
    }

    const updatedBalance = Number(user.balance) - amount;

    await db(
      "users",
      supabase
        .from("users")
        .update({ balance: updatedBalance })
        .eq("telegram_id", String(user.telegram_id))
    );

    const withdrawal = await db(
      "withdrawals",
      supabase
        .from("withdrawals")
        .insert({
          telegram_id: String(user.telegram_id),
          amount,
          method,
          account,
          status: "pending",
          created_at: new Date().toISOString()
        })
        .select("*")
        .single()
    );

    await addTransaction(
      user.telegram_id,
      -amount,
      "withdrawal_pending",
      "Withdrawal request",
      withdrawal.id
    );

    res.json({
      success: true,
      withdrawal,
      balance: updatedBalance
    });
  } catch (e) {
    console.error("[WITHDRAWAL CREATE ERROR]", e);
    fail(res, 400, e.message);
  }
});

app.get("/api/withdrawals", telegramAuth, async (req, res) => {
  try {
    const rows = await db(
      "withdrawals",
      supabase
        .from("withdrawals")
        .select("id, amount, method, status, created_at")
        .eq("telegram_id", String(req.telegramUser.id))
        .order("created_at", { ascending: false })
        .limit(30)
    );

    res.json({ withdrawals: rows || [] });
  } catch (e) {
    console.error("[WITHDRAWALS LIST ERROR]", e);
    fail(res, 400, e.message);
  }
});

/* ADMIN: USERS */

app.get("/api/admin/users", adminAuth, async (req, res) => {
  try {
    const users = await db(
      "users",
      supabase
        .from("users")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(500)
    );

    res.json({ users: users || [] });
  } catch (e) {
    console.error("[ADMIN USERS ERROR]", e);
    fail(res, 400, e.message);
  }
});

app.patch("/api/admin/users/:id", adminAuth, async (req, res) => {
  try {
    const id = String(req.params.id);
    const patch = {};

    if (typeof req.body?.is_blocked === "boolean") {
      patch.is_blocked = req.body.is_blocked;
    }

    if (typeof req.body?.display_name === "string") {
      const name = req.body.display_name.trim();

      if (!name || name.length > 40) {
        return fail(res, 400, "Invalid display name.");
      }

      patch.display_name = name;
    }

    if (!Object.keys(patch).length) {
      return fail(res, 400, "No valid changes.");
    }

    const user = await db(
      "users",
      supabase
        .from("users")
        .update(patch)
        .eq("telegram_id", id)
        .select("*")
        .single()
    );

    res.json({ success: true, user });
  } catch (e) {
    console.error("[ADMIN USER UPDATE ERROR]", e);
    fail(res, 400, e.message);
  }
});

app.post("/api/admin/users/:id/points", adminAuth, async (req, res) => {
  try {
    const id = String(req.params.id);
    const amount = Number(req.body?.amount);
    const reason = String(req.body?.reason || "").trim();

    if (
      !Number.isInteger(amount) ||
      amount === 0 ||
      Math.abs(amount) > 1000000
    ) {
      return fail(res, 400, "Invalid points amount.");
    }

    if (!reason || reason.length > 200) {
      return fail(res, 400, "A reason is required.");
    }

    const user = await getUser(id);

    if (!user) return fail(res, 404, "User not found.");

    const balance = Number(user.balance || 0) + amount;

    if (balance < 0) {
      return fail(res, 400, "Balance cannot be negative.");
    }

    await db(
      "users",
      supabase.from("users").update({ balance }).eq("telegram_id", id)
    );

    await addTransaction(id, amount, "admin_adjustment", reason);

    await db(
      "admin_logs",
      supabase.from("admin_logs").insert({
        admin_telegram_id: ADMIN_TELEGRAM_ID,
        target_telegram_id: id,
        action: "points_adjustment",
        details: { amount, reason },
        created_at: new Date().toISOString()
      })
    );

    /* SEND POINTS ADJUSTMENT REASON TO THAT USER'S NOTIFICATIONS */

    await db(
      "admin_messages",
      supabase.from("admin_messages").insert({
        title: amount > 0 ? "FP Points Added" : "FP Points Deducted",
        message: `${Math.abs(amount)} FP ${
          amount > 0 ? "যোগ করা হয়েছে" : "বিয়োগ করা হয়েছে"
        }। কারণ: ${reason}`,
        created_by: ADMIN_TELEGRAM_ID,
        target_telegram_id: id,
        active: true,
        created_at: new Date().toISOString()
      })
    );

    res.json({ success: true, balance });
  } catch (e) {
    console.error("[ADMIN POINTS ERROR]", e);
    fail(res, 400, e.message);
  }
});

/* ADMIN: MESSAGES & HISTORY */

app.get("/api/admin/messages", adminAuth, async (req, res) => {
  try {
    const messages = await db(
      "admin_messages",
      supabase
        .from("admin_messages")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(500)
    );

    res.json({ messages: messages || [] });
  } catch (e) {
    console.error("[ADMIN MESSAGES LIST ERROR]", e);
    fail(res, 400, e.message);
  }
});

app.post("/api/admin/messages", adminAuth, async (req, res) => {
  try {
    const title = String(req.body?.title || "").trim();
    const message = String(req.body?.message || "").trim();

    if (!title || title.length > 100) {
      return fail(res, 400, "শিরোনাম ১ থেকে ১০০ অক্ষরের মধ্যে দিন।");
    }

    if (!message || message.length > 2000) {
      return fail(res, 400, "মেসেজ ১ থেকে ২০০০ অক্ষরের মধ্যে দিন।");
    }

    const created = await db(
      "admin_messages",
      supabase
        .from("admin_messages")
        .insert({
          title,
          message,
          created_by: ADMIN_TELEGRAM_ID,
          active: true,
          created_at: new Date().toISOString()
        })
        .select("*")
        .single()
    );

    res.json({ success: true, message: created });
  } catch (e) {
    console.error("[ADMIN MESSAGE CREATE ERROR]", e);
    fail(res, 400, e.message);
  }
});

app.delete("/api/admin/messages/:id", adminAuth, async (req, res) => {
  try {
    const id = String(req.params.id || "");

    if (!id) return fail(res, 400, "Message ID required.");

    const deleted = await db(
      "admin_messages",
      supabase
        .from("admin_messages")
        .delete()
        .eq("id", id)
        .select("id")
    );

    if (!deleted || deleted.length === 0) {
      return fail(res, 404, "Message not found.");
    }

    res.json({ success: true });
  } catch (e) {
    console.error("[ADMIN MESSAGE DELETE ERROR]", e);
    fail(res, 400, e.message);
  }
});

/* ADMIN: WITHDRAWALS */

app.get("/api/admin/withdrawals", adminAuth, async (req, res) => {
  try {
    const rows = await db(
      "withdrawals",
      supabase
        .from("withdrawals")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(500)
    );

    res.json({ withdrawals: rows || [] });
  } catch (e) {
    console.error("[ADMIN WITHDRAWALS ERROR]", e);
    fail(res, 400, e.message);
  }
});

app.post(
  "/api/admin/withdrawals/:id/review",
  adminAuth,
  async (req, res) => {
    try {
      const id = String(req.params.id);
      const action = String(req.body?.action || "");

      if (!["approve", "reject"].includes(action)) {
        return fail(res, 400, "Action must be approve or reject.");
      }

      const withdrawal = await db(
        "withdrawals",
        supabase
          .from("withdrawals")
          .select("*")
          .eq("id", id)
          .maybeSingle()
      );

      if (!withdrawal) return fail(res, 404, "Withdrawal not found.");

      if (withdrawal.status !== "pending") {
        return fail(res, 400, "Already reviewed.");
      }

      if (action === "reject") {
        const user = await getUser(withdrawal.telegram_id);

        if (!user) return fail(res, 404, "User not found.");

        await db(
          "users",
          supabase
            .from("users")
            .update({
              balance:
                Number(user.balance || 0) + Number(withdrawal.amount)
            })
            .eq("telegram_id", String(withdrawal.telegram_id))
        );

        await addTransaction(
          withdrawal.telegram_id,
          Number(withdrawal.amount),
          "withdrawal_refund",
          "Withdrawal rejected; points refunded",
          id
        );
      }

      await db(
        "withdrawals",
        supabase
          .from("withdrawals")
          .update({
            status: action === "approve" ? "approved" : "rejected",
            reviewed_at: new Date().toISOString(),
            reviewed_by: ADMIN_TELEGRAM_ID
          })
          .eq("id", id)
          .eq("status", "pending")
      );

      res.json({ success: true });
    } catch (e) {
      console.error("[ADMIN WITHDRAWAL REVIEW ERROR]", e);
      fail(res, 400, e.message);
    }
  }
);

/* ADMIN: BADGE REQUESTS */

app.get("/api/admin/shop-requests", adminAuth, async (req, res) => {
  try {
    const rows = await db(
      "shop_requests",
      supabase
        .from("shop_requests")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(500)
    );

    res.json({ requests: rows || [] });
  } catch (e) {
    console.error("[ADMIN SHOP REQUESTS ERROR]", e);
    fail(res, 400, e.message);
  }
});

app.post(
  "/api/admin/shop-requests/:id/review",
  adminAuth,
  async (req, res) => {
    try {
      const id = String(req.params.id);
      const action = String(req.body?.action || "");

      if (!["approve", "reject"].includes(action)) {
        return fail(res, 400, "Action must be approve or reject.");
      }

      const result = await db(
        "review_badge_request",
        supabase.rpc("review_badge_request", {
          p_request_id: id,
          p_action: action,
          p_admin_id: ADMIN_TELEGRAM_ID
        })
      );

      res.json(result);
    } catch (e) {
      console.error("[ADMIN SHOP REVIEW ERROR]", e);
      fail(res, 400, e.message);
    }
  }
);

/* ADMIN: SOCIAL TASKS */

app.get("/api/admin/social-tasks", adminAuth, async (req, res) => {
  try {
    const rows = await db(
      "social_tasks",
      supabase
        .from("social_tasks")
        .select("*")
        .order("created_at", { ascending: false })
    );

    res.json({ tasks: rows || [] });
  } catch (e) {
    console.error("[ADMIN SOCIAL TASKS ERROR]", e);
    fail(res, 400, e.message);
  }
});

app.post("/api/admin/social-tasks", adminAuth, async (req, res) => {
  try {
    const title = String(req.body?.title || "").trim();
    const description = String(req.body?.description || "").trim();
    const url = String(req.body?.url || "").trim();
    const channelUsername = String(req.body?.channel_username || "").trim();
    const reward = Number(req.body?.reward);

    if (!title || title.length > 100) {
      return fail(res, 400, "Invalid title.");
    }

    if (!Number.isInteger(reward) || reward < 1 || reward > DAILY_MAX) {
      return fail(res, 400, "Invalid reward.");
    }

    const task = await db(
      "social_tasks",
      supabase
        .from("social_tasks")
        .insert({
          title,
          description,
          url,
          platform: "telegram",
          channel_username: channelUsername,
          reward,
          enabled: true,
          created_at: new Date().toISOString()
        })
        .select("*")
        .single()
    );

    res.json({ success: true, task });
  } catch (e) {
    console.error("[ADMIN SOCIAL TASK CREATE ERROR]", e);
    fail(res, 400, e.message);
  }
});

app.patch(
  "/api/admin/social-tasks/:id",
  adminAuth,
  async (req, res) => {
    try {
      const patch = {};

      if (typeof req.body?.enabled === "boolean") {
        patch.enabled = req.body.enabled;
      }

      if (typeof req.body?.title === "string") {
        patch.title = req.body.title.trim();
      }

      if (typeof req.body?.description === "string") {
        patch.description = req.body.description.trim();
      }

      if (!Object.keys(patch).length) {
        return fail(res, 400, "No changes provided.");
      }

      const task = await db(
        "social_tasks",
        supabase
          .from("social_tasks")
          .update(patch)
          .eq("id", String(req.params.id))
          .select("*")
          .single()
      );

      res.json({ success: true, task });
    } catch (e) {
      console.error("[ADMIN SOCIAL TASK UPDATE ERROR]", e);
      fail(res, 400, e.message);
    }
  }
);

/* ADMIN: DASHBOARD STATS */

app.get("/api/admin/stats", adminAuth, async (req, res) => {
  try {
    const users = await db(
      "users",
      supabase.from("users").select("telegram_id,is_blocked")
    );

    const withdrawals = await db(
      "withdrawals",
      supabase.from("withdrawals").select("id,status")
    );

    const shop = await db(
      "shop_requests",
      supabase.from("shop_requests").select("id,status")
    );

    res.json({
      totalUsers: users.length,
      activeUsers: users.filter((u) => !u.is_blocked).length,
      blockedUsers: users.filter((u) => u.is_blocked).length,
      pendingWithdrawals: withdrawals.filter((w) => w.status === "pending").length,
      pendingBadgeRequests: shop.filter((s) => s.status === "pending").length
    });
  } catch (e) {
    console.error("[ADMIN STATS ERROR]", e);
    fail(res, 400, e.message);
  }
});

/* GLOBAL ERROR HANDLER */

app.use((err, req, res, next) => {
  console.error("[UNHANDLED ERROR]", err);

  if (res.headersSent) return next(err);

  res.status(500).json({
    error: "Internal server error."
  });
});

/* START SERVER */

app.listen(PORT, () => {
  console.log(`FP Points backend listening on port ${PORT}`);
});
