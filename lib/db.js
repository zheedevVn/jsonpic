const fs = require("fs");
const path = require("path");

const DB_FILE = path.join("/tmp", "jsonpic_settings.json");

function getSettings() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    }
  } catch (e) {}

  return {
    allowedIps: [],
    allowedDomains: ["jsonpic.vercel.app", "api-zhee.vercel.app"],
    recentUploads: []
  };
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(settings, null, 2), "utf8");
  } catch (e) {}
}

module.exports = {
  getSettings,
  saveSettings
};
