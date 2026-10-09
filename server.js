
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use(cors({
  origin: "https://fc-points-miniapp.onrender.com"
}));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const DAILY_MAX = 650;
const NORMAL_MAX = 200;
const CHECKIN_REWARD = 5;
const DAILY_BONUS_REWARD = 5;
const MISSION_REWARD = 5;
const EARN_BONUS_REWARD = 15;
const MAX_DAILY_ADS = 20;

function getDhakaDate(timestamp = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(timestamp);

  const values = {};
  for (const part of parts) values[part.type] = part.value;

  return `${values.year}-${values.month}-${values.day}`;
}

function sendError(res, status, message) {
  return res.status(status).json({
    status: "error",
    message
  });
}

async function getActiveUser(telegram_id) {
  const { data, error } = await supabase
    .from("users")
    .select("telegram_id, fp_points, is_blocked, is_active")
    .eq("telegram_id", String(telegram_id))
    .maybeSingle();

  if (error) throw error;
  if (!data) return { error: "User not found", status: 404 };

  if (data.is_blocked || !data.is_active) {
    return { error: "User is blocked or inactive", status: 403 };
  }

  return { user: data };
}

async function getDailyRewards(telegram_id) {
  const { data, error } = await supabase
    .from("daily_rewards")
    .select("*")
    .eq("telegram_id", String(telegram_id))
    .maybeSingle();

  if (error) throw error;
  return data || {};
}

async function getDailyActivity(telegram_id) {
  const today = getDhakaDate();

  const { data, error } = await supabase
    .from("daily_activity")
    .select("*")
    .eq("telegram_id", String(telegram_id))
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    const fresh = {
      telegram_id: String(telegram_id),
      ad_date: today,
      ad_count: 0,
      daily_bonus_date: null,
      mission_date: null,
      earn_bonus_date: null,
      updated_at: new Date().toISOString()
    };

    const { data: inserted, error: insertError } = await supabase
      .from("daily_activity")
      .insert(fresh)
      .select()
      .single();

    if (insertError) throw insertError;
    return inserted;
  }

  if (data.ad_date !== today) {
    const reset = {
      ad_date: today,
      ad_count: 0,
      daily_bonus_date: null,
      mission_date: null,
      earn_bonus_date: null,
      updated_at: new Date().toISOString()
    };

    const { data: updated, error: updateError } = await supabase
      .from("daily_activity")
      .update(reset)
      .eq("telegram_id", String(telegram_id))
      .select()
      .single();

    if (updateError) throw updateError;
    return updated;
  }

  return data;
}

async function getTodayTotal(telegram_id) {
  const today = getDhakaDate();
  const rewards = await getDailyRewards(telegram_id);
  const activity = await getDailyActivity(telegram_id);

  let total = 0;

  if (rewards.reward_date === today) {
    total += Number(rewards.normal_earning_points || 0);
  }

  if (
    rewards.checkin_claimed_at &&
    getDhakaDate(new Date(rewards.checkin_claimed_at)) === today
  ) {
    total += CHECKIN_REWARD;
  }

  total += Number(activity.ad_count || 0) * EARN_BONUS_REWARD;

  if (activity.daily_bonus_date === today) {
    total += DAILY_BONUS_REWARD;
  }

  if (activity.mission_date === today) {
    total += MISSION_REWARD;
  }

  return total;
}

// Home
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "FP Points Backend",
    version: "1.3"
  });
});

// Database health
app.get("/health", async (req, res) => {
  try {
    const { error } = await supabase
      .from("app_settings")
      .select("key")
      .limit(1);

    if (error) {
      return sendError(res, 500, error.message);
    }

    res.json({
      status: "ok",
      database: "connected"
    });
  } catch (error) {
    sendError(res, 500, error.message);
  }
});

// Register Telegram user
app.post("/api/user/register", async (req, res) => {
  try {
    const {
      telegram_id,
      first_name,
      last_name,
      username,
      photo_url
    } = req.body;

    if (!telegram_id) {
      return sendError(res, 400, "telegram_id is required");
    }

    const { data, error } = await supabase
      .from("users")
      .upsert({
        telegram_id: String(telegram_id),
        first_name: first_name || null,
        last_name: last_name || null,
        username: username || null,
        photo_url: photo_url || null,
        is_active: true,
        updated_at: new Date().toISOString()
      }, {
        onConflict: "telegram_id"
      })
      .select()
      .single();

    if (error) return sendError(res, 500, error.message);

    res.json({
      status: "ok",
      message: "User registered successfully",
      user: data
    });
  } catch (error) {
    sendError(res, 500, error.message);
  }
});

// Get user and balance
app.get("/api/user/:telegram_id", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("users")
      .select(
        "telegram_id, first_name, last_name, username, photo_url, fp_points, is_blocked, is_active"
      )
      .eq("telegram_id", String(req.params.telegram_id))
      .maybeSingle();

    if (error) return sendError(res, 500, error.message);
    if (!data) return sendError(res, 404, "User not found");

    res.json({
      status: "ok",
      user: data
    });
  } catch (error) {
    sendError(res, 500, error.message);
  }
});

// Normal earning: 200 FP maximum per Dhaka day
app.post("/api/earning/claim", async (req, res) => {
  try {
    const { telegram_id, points } = req.body;

    if (
      !telegram_id ||
      !Number.isInteger(points) ||
      points <= 0 ||
      points > NORMAL_MAX
    ) {
      return sendError(res, 400, "Invalid earning request");
    }

    const result = await getActiveUser(telegram_id);
    if (result.error) return sendError(res, result.status, result.error);

    const today = getDhakaDate();
    const rewards = await getDailyRewards(telegram_id);

    const currentNormal =
      rewards.reward_date === today
        ? Number(rewards.normal_earning_points || 0)
        : 0;

    if (currentNormal + points > NORMAL_MAX) {
      return sendError(res, 400, "Daily normal earning limit reached");
    }

    const total = await getTodayTotal(telegram_id);
    if (total + points > DAILY_MAX) {
      return sendError(res, 400, "Daily total earning limit reached");
    }

    const newBalance = Number(result.user.fp_points || 0) + points;
    const now = new Date().toISOString();

    const { error: balanceError } = await supabase
      .from("users")
      .update({
        fp_points: newBalance,
        updated_at: now
      })
      .eq("telegram_id", String(telegram_id));

    if (balanceError) return sendError(res, 500, balanceError.message);

    const { error: rewardError } = await supabase
      .from("daily_rewards")
      .upsert({
        telegram_id: String(telegram_id),
        normal_earning_points: currentNormal + points,
        reward_date: today,
        updated_at: now
      }, {
        onConflict: "telegram_id"
      });

    if (rewardError) return sendError(res, 500, rewardError.message);

    res.json({
      status: "ok",
      message: "Earning claimed",
      added: points,
      balance: newBalance,
      normal_earning_today: currentNormal + points
    });
  } catch (error) {
    sendError(res, 500, error.message);
  }
});

// Daily Check-in status
app.get("/api/checkin/status/:telegram_id", async (req, res) => {
  try {
    const telegram_id = req.params.telegram_id;
    const today = getDhakaDate();

    const { data: user, error: userError } = await supabase
      .from("users")
      .select("telegram_id")
      .eq("telegram_id", String(telegram_id))
      .maybeSingle();

    if (userError) return sendError(res, 500, userError.message);
    if (!user) return sendError(res, 404, "User not found");

    const rewards = await getDailyRewards(telegram_id);

    const claimed = Boolean(
      rewards.checkin_claimed_at &&
      getDhakaDate(new Date(rewards.checkin_claimed_at)) === today
    );

    res.json({
      status: "ok",
      claimed,
      checkin_date: claimed ? today : null
    });
  } catch (error) {
    sendError(res, 500, error.message);
  }
});

// Daily Check-in: 5 FP once per day
app.post("/api/checkin/claim", async (req, res) => {
  try {
    const { telegram_id } = req.body;

    if (!telegram_id) {
      return sendError(res, 400, "telegram_id is required");
    }

    const result = await getActiveUser(telegram_id);
    if (result.error) return sendError(res, result.status, result.error);

    const today = getDhakaDate();
    const rewards = await getDailyRewards(telegram_id);

    if (
      rewards.checkin_claimed_at &&
      getDhakaDate(new Date(rewards.checkin_claimed_at)) === today
    ) {
      return sendError(res, 400, "Daily Check-in already claimed today");
    }

    const total = await getTodayTotal(telegram_id);
    if (total + CHECKIN_REWARD > DAILY_MAX) {
      return sendError(res, 400, "Daily total earning limit reached");
    }

    const now = new Date().toISOString();
    const newBalance = Number(result.user.fp_points || 0) + CHECKIN_REWARD;

    const { error: balanceError } = await supabase
      .from("users")
      .update({
        fp_points: newBalance,
        updated_at: now
      })
      .eq("telegram_id", String(telegram_id));

    if (balanceError) return sendError(res, 500, balanceError.message);

    const { error: rewardError } = await supabase
      .from("daily_rewards")
      .upsert({
        telegram_id: String(telegram_id),
        checkin_claimed_at: now,
        reward_date: today,
        updated_at: now
      }, {
        onConflict: "telegram_id"
      });

    if (rewardError) return sendError(res, 500, rewardError.message);

    res.json({
      status: "ok",
      message: "Daily Check-in successful",
      added: CHECKIN_REWARD,
      balance: newBalance,
      checkin_date: today
    });
  } catch (error) {
    sendError(res, 500, error.message);
  }
});

// Get Daily Tasks status
app.get("/api/tasks/status/:telegram_id", async (req, res) => {
  try {
    const telegram_id = req.params.telegram_id;
    const result = await getActiveUser(telegram_id);

    if (result.error) {
      return sendError(res, result.status, result.error);
    }

    const today = getDhakaDate();
    const activity = await getDailyActivity(telegram_id);
    const rewards = await getDailyRewards(telegram_id);

    const checkinClaimed = Boolean(
      rewards.checkin_claimed_at &&
      getDhakaDate(new Date(rewards.checkin_claimed_at)) === today
    );

    res.json({
      status: "ok",
      date: today,
      checkin: {
        reward: CHECKIN_REWARD,
        claimed: checkinClaimed
      },
      daily_bonus: {
        reward: DAILY_BONUS_REWARD,
        claimed: activity.daily_bonus_date === today
      },
      daily_mission: {
        reward: MISSION_REWARD,
        required_ads: MAX_DAILY_ADS,
        ads_completed: Number(activity.ad_count || 0),
        claimed: activity.mission_date === today
      },
      earn_bonus: {
        reward_per_ad: EARN_BONUS_REWARD,
        ads_completed: Number(activity.ad_count || 0),
        daily_limit: MAX_DAILY_ADS
      },
      total_points_today: await getTodayTotal(telegram_id),
      daily_maximum: DAILY_MAX
    });
  } catch (error) {
    sendError(res, 500, error.message);
  }
});

// Daily Bonus: 5 FP once per day
app.post("/api/tasks/daily-bonus", async (req, res) => {
  try {
    const { telegram_id } = req.body;

    if (!telegram_id) {
      return sendError(res, 400, "telegram_id is required");
    }

    const result = await getActiveUser(telegram_id);
    if (result.error) return sendError(res, result.status, result.error);

    const today = getDhakaDate();
    const activity = await getDailyActivity(telegram_id);

    if (activity.daily_bonus_date === today) {
      return sendError(res, 400, "Daily Bonus already claimed today");
    }

    const total = await getTodayTotal(telegram_id);
    if (total + DAILY_BONUS_REWARD > DAILY_MAX) {
      return sendError(res, 400, "Daily total earning limit reached");
    }

    const now = new Date().toISOString();
    const newBalance =
      Number(result.user.fp_points || 0) + DAILY_BONUS_REWARD;

    const { error: balanceError } = await supabase
      .from("users")
      .update({
        fp_points: newBalance,
        updated_at: now
      })
      .eq("telegram_id", String(telegram_id));

    if (balanceError) return sendError(res, 500, balanceError.message);

    const { error: activityError } = await supabase
      .from("daily_activity")
      .update({
        daily_bonus_date: today,
        updated_at: now
      })
      .eq("telegram_id", String(telegram_id));

    if (activityError) return sendError(res, 500, activityError.message);

    res.json({
      status: "ok",
      message: "Daily Bonus claimed",
      added: DAILY_BONUS_REWARD,
      balance: newBalance
    });
  } catch (error) {
    sendError(res, 500, error.message);
  }
});

// Record a completed rewarded ad and award Earn Bonus.
// This endpoint must be connected to verified ad completion before production use.
app.post("/api/tasks/ad-completed", async (req, res) => {
  try {
    const { telegram_id } = req.body;

    if (!telegram_id) {
      return sendError(res, 400, "telegram_id is required");
    }

    const result = await getActiveUser(telegram_id);
    if (result.error) return sendError(res, result.status, result.error);

    const today = getDhakaDate();
    const activity = await getDailyActivity(telegram_id);
    const currentAds = Number(activity.ad_count || 0);

    if (currentAds >= MAX_DAILY_ADS) {
      return sendError(res, 400, "Daily ad limit reached");
    }

    const nextAds = currentAds + 1;
    const missionWillComplete =
      nextAds >= MAX_DAILY_ADS &&
      activity.mission_date !== today;

    const rewardToAdd =
      EARN_BONUS_REWARD +
      (missionWillComplete ? MISSION_REWARD : 0);

    const total = await getTodayTotal(telegram_id);
    if (total + rewardToAdd > DAILY_MAX) {
      return sendError(res, 400, "Daily total earning limit reached");
    }

    const now = new Date().toISOString();
    const newBalance =
      Number(result.user.fp_points || 0) + rewardToAdd;

    const { error: balanceError } = await supabase
      .from("users")
      .update({
        fp_points: newBalance,
        updated_at: now
      })
      .eq("telegram_id", String(telegram_id));

    if (balanceError) return sendError(res, 500, balanceError.message);

    const activityUpdate = {
      ad_count: nextAds,
      ad_date: today,
      updated_at: now
    };

    if (missionWillComplete) {
      activityUpdate.mission_date = today;
    }

    const { error: activityError } = await supabase
      .from("daily_activity")
      .update(activityUpdate)
      .eq("telegram_id", String(telegram_id));

    if (activityError) return sendError(res, 500, activityError.message);

    res.json({
      status: "ok",
      message: "Ad activity recorded",
      added: rewardToAdd,
      earn_bonus: EARN_BONUS_REWARD,
      mission_completed: missionWillComplete,
      mission_reward: missionWillComplete ? MISSION_REWARD : 0,
      ads_completed: nextAds,
      ads_remaining: MAX_DAILY_ADS - nextAds,
      balance: newBalance
    });
  } catch (error) {
    sendError(res, 500, error.message);
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`FP Points Backend running on port ${PORT}`);
});
