
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "FP Points Backend",
    version: "1.0"
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok"
  });
});

app.listen(PORT, () => {
  console.log(`FP Points Backend running on port ${PORT}`);
});
