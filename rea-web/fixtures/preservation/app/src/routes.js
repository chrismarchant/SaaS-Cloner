const express = require("express");

const router = express.Router();
const app = express();

router.get("/api/notes", (req, res) => res.json([]));
router.post("/api/notes", (req, res) => res.status(201).json({}));
app.get("/health", (req, res) => res.send("ok"));

const dsn = process.env.DATABASE_URL;
const stripeKey = process.env["STRIPE_SECRET_KEY"];

module.exports = {
  router,
  app,
  dsn,
  stripeKey,
  handle: (req, res) => res.end("ok"),
};
