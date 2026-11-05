import { readFileSync } from "node:fs";
import { validateNpmAuditReport } from "./validate-npm-audit.js";


export const validateMobileAuditReport = (report, lockfile = JSON.parse(readFileSync("apps/mobile/package-lock.json", "utf8"))) => {
  validateNpmAuditReport(report, "mobile", lockfile);
};

if (import.meta.main) {
  try {
    const reportPath = process.argv[2];
    if (!reportPath) throw new Error("usage: validate-mobile-npm-audit.js <report.json>");
    validateMobileAuditReport(JSON.parse(readFileSync(reportPath, "utf8")));
    console.log("Accepted only the reviewed mobile build-tool advisory closure.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
