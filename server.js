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

function getDhakaDate(timestamp = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(timestamp);

  const values = {};

  for (const part of parts) {
    values[part.type] = part.value;
  }

  return `${values.year}-${values.month}-${values.day}`;
}

// Home
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "FP Points Backend",
    version: "1.2"
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
      return res.status(500).json({
        status: "error",
        database: "disconnected",
        message: error.message
      });
    }

    res.json({
      status: "ok",
      database: "connected"
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      database: "disconnected",
      message: error.message
    });
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
      return res.status(400).json({
        status: "error",
        message: "telegram_id is required"
      });
    }

    const { data, error } = await supabase
      .from("users")
      .upsert({
        telegram_id,
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

    if (error) {
      return res.status(500).json({
        status: "error",
        message: error.message
      });
    }

    res.json({
      status: "ok",
      message: "User registered successfully",
      user: data
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

// Get user details and balance
app.get("/api/user/:telegram_id", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("users")
      .select(
        "telegram_id, first_name, last_name, username, photo_url, fp_points, is_blocked, is_active"
      )
      .eq("telegram_id", req.params.telegram_id)
      .maybeSingle();

    if (error) {
      return res.status(500).json({
        status: "error",
        message: error.message
      });
    }

    if (!data) {
      return res.status(404).json({
        status: "error",
        message: "User not found"
      });
    }

    res.json({
      status: "ok",
      user: data
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

// Normal earning: maximum 200 FP per Dhaka day
app.post("/api/earning/claim", async (req, res) => {
  try {
    const { telegram_id, points } = req.body;

    if (
      !telegram_id ||
      !Number.isInteger(points) ||
      points <= 0 ||
      points > 200
    ) {
      return res.status(400).json({
        status: "error",
        message: "Invalid earning request"
      });
    }

    const { data: user, error: userError } = await supabase
      .from("users")
      .select("fp_points, is_blocked, is_active")
      .eq("telegram_id", telegram_id)
      .maybeSingle();

    if (userError || !user) {
      return res.status(404).json({
        status: "error",
        message: "User not found"
      });
    }

    if (user.is_blocked || !user.is_active) {
      return res.status(403).json({
        status: "error",
        message: "User is blocked or inactive"
      });
    }

    const today = getDhakaDate();

    const { data: reward, error: rewardError } = await supabase
      .from("daily_rewards")
      .select("normal_earning_points, reward_date")
      .eq("telegram_id", telegram_id)
      .maybeSingle();

    if (rewardError) {
      return res.status(500).json({
        status: "error",
        message: rewardError.message
      });
    }

    const currentNormal =
      reward && reward.reward_date === today
        ? Number(reward.normal_earning_points || 0)
        : 0;

    if (currentNormal + points > 200) {
      return res.status(400).json({
        status: "error",
        message: "Daily normal earning limit reached"
      });
    }

    const newBalance = Number(user.fp_points || 0) + points;
    const newNormal = currentNormal + points;

    const { error: balanceError } = await supabase
      .from("users")
      .update({
        fp_points: newBalance,
        updated_at: new Date().toISOString()
      })
      .eq("telegram_id", telegram_id);

    if (balanceError) {
      return res.status(500).json({
        status: "error",
        message: balanceError.message
      });
    }

    const { error: updateError } = await supabase
      .from("daily_rewards")
      .upsert({
        telegram_id,
        normal_earning_points: newNormal,
        reward_date: today,
        updated_at: new Date().toISOString()
      }, {
        onConflict: "telegram_id"
      });

    if (updateError) {
      return res.status(500).json({
        status: "error",
        message: updateError.message
      });
    }

    res.json({
      status: "ok",
      message: "Earning claimed",
      added: points,
      balance: newBalance,
      normal_earning_today: newNormal
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

// Daily Check-in status: check whether today's reward was claimed
app.get("/api/checkin/status/:telegram_id", async (req, res) => {
  try {
    const { telegram_id } = req.params;

    const { data: user, error: userError } = await supabase
      .from("users")
      .select("telegram_id")
      .eq("telegram_id", telegram_id)
      .maybeSingle();

    if (userError) {
      return res.status(500).json({
        status: "error",
        message: userError.message
      });
    }

    if (!user) {
      return res.status(404).json({
        status: "error",
        message: "User not found"
      });
    }

    const { data, error } = await supabase
      .from("daily_rewards")
      .select("checkin_claimed_at")
      .eq("telegram_id", telegram_id)
      .maybeSingle();

    if (error) {
      return res.status(500).json({
        status: "error",
        message: error.message
      });
    }

    const today = getDhakaDate();

    const claimed = Boolean(
      data?.checkin_claimed_at &&
      getDhakaDate(new Date(data.checkin_claimed_at)) === today
    );

    res.json({
      status: "ok",
      claimed,
      checkin_date: claimed ? today : null
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

// Daily Check-in: 10 FP once per Dhaka calendar day
app.post("/api/checkin/claim", async (req, res) => {
  try {
    const { telegram_id } = req.body;

    if (!telegram_id) {
      return res.status(400).json({
        status: "error",
        message: "telegram_id is required"
      });
    }

    const { data: user, error: userError } = await supabase
      .from("users")
      .select("fp_points, is_blocked, is_active")
      .eq("telegram_id", telegram_id)
      .maybeSingle();

    if (userError || !user) {
      return res.status(404).json({
        status: "error",
        message: "User not found"
      });
    }

    if (user.is_blocked || !user.is_active) {
      return res.status(403).json({
        status: "error",
        message: "User is blocked or inactive"
      });
    }

    const today = getDhakaDate();

    const { data: reward, error: rewardError } = await supabase
      .from("daily_rewards")
      .select("checkin_claimed_at")
      .eq("telegram_id", telegram_id)
      .maybeSingle();

    if (rewardError) {
      return res.status(500).json({
        status: "error",
        message: rewardError.message
      });
    }

    if (
      reward?.checkin_claimed_at &&
      getDhakaDate(new Date(reward.checkin_claimed_at)) === today
    ) {
      return res.status(400).json({
        status: "error",
        message: "Daily Check-in already claimed today"
      });
    }

    const rewardPoints = 10;
    const now = new Date().toISOString();
    const newBalance = Number(user.fp_points || 0) + rewardPoints;

    const { error: balanceError } = await supabase
      .from("users")
      .update({
        fp_points: newBalance,
        updated_at: now
      })
      .eq("telegram_id", telegram_id);

    if (balanceError) {
      return res.status(500).json({
        status: "error",
        message: balanceError.message
      });
    }

    const { error: updateError } = await supabase
      .from("daily_rewards")
      .upsert({
        telegram_id,
        checkin_claimed_at: now,
        reward_date: today,
        updated_at: now
      }, {
        onConflict: "telegram_id"
      });

    if (updateError) {
      return res.status(500).json({
        status: "error",
        message: updateError.message
      });
    }

    res.json({
      status: "ok",
      message: "Daily Check-in successful",
      added: rewardPoints,
      balance: newBalance,
      checkin_date: today
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`FP Points Backend running on port ${PORT}`);
});
