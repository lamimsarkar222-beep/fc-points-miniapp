const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "FP Points Backend",
    version: "1.0"
  });
});

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

app.listen(PORT, () => {
  console.log(`FP Points Backend running on port ${PORT}`);
});
