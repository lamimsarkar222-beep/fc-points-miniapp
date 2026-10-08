const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

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

// Database health check
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

app.listen(PORT, () => {
  console.log(`FP Points Backend running on port ${PORT}`);
});
