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

// Home
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "FP Points Backend",
    version: "1.0"
  });
});

// Database health
app.get("/health", async (req, res) => {
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
      .upsert(
        {
          telegram_id,
          first_name: first_name || null,
          last_name: last_name || null,
          username: username || null,
          photo_url: photo_url || null,
          is_active: true,
          updated_at: new Date().toISOString()
        },
        {
          onConflict: "telegram_id"
        }
      )
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

// Get user balance
app.get("/api/user/:telegram_id", async (req, res) => {
  try {
    const telegram_id = req.params.telegram_id;

    const { data, error } = await supabase
      .from("users")
      .select(
        "telegram_id, first_name, last_name, username, photo_url, fp_points, is_blocked, is_active"
      )
      .eq("telegram_id", telegram_id)
      .single();

    if (error) {
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

// Normal earning
app.post("/api/earning/claim", async (req, res) => {
  try {
    const { telegram_id, points } = req.body;

    if (!telegram_id || !Number.isInteger(points) || points <= 0) {
      return res.status(400).json({
        status: "error",
        message: "Invalid earning request"
      });
    }

    if (points > 200) {
      return res.status(400).json({
        status: "error",
        message: "Daily normal earning limit is 200 FP"
      });
    }

    const { data: user, error: userError } = await supabase
      .from("users")
      .select("fp_points, is_blocked, is_active")
      .eq("telegram_id", telegram_id)
      .single();

    if (userError || !user) {
      return res.status(404).json({
        status: "error",
        message: "User not found"
      });
    }

    if (user.is_blocked) {
      return res.status(403).json({
        status: "error",
        message: "User is blocked"
      });
    }

    if (!user.is_active) {
      return res.status(403).json({
        status: "error",
        message: "User is inactive"
      });
    }

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

    const today = new Date().toISOString().slice(0, 10);

    let currentNormal = 0;

    if (reward && reward.reward_date === today) {
      currentNormal = reward.normal_earning_points || 0;
    }

    if (currentNormal + points > 200) {
      return res.status(400).json({
        status: "error",
        message: "Daily normal earning limit reached"
      });
    }

    const newBalance = (user.fp_points || 0) + points;
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

    const { error: rewardUpdateError } = await supabase
      .from("daily_rewards")
      .upsert(
        {
          telegram_id,
          normal_earning_points: newNormal,
          reward_date: today,
          updated_at: new Date().toISOString()
        },
        {
          onConflict: "telegram_id"
        }
      );

    if (rewardUpdateError) {
      return res.status(500).json({
        status: "error",
        message: rewardUpdateError.message
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

app.listen(PORT, () => {
  console.log(`FP Points Backend running on port ${PORT}`);
});
