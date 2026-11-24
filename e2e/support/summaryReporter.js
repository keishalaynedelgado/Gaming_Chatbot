'use strict';
// Adds the PASS / FAIL / BLOCKED view on top of Playwright's own results
// (Playwright itself only knows passed / failed / skipped): printed at the end
// of the run and saved next to the HTML report as summary.md / summary.json.
// Nothing here decides an outcome -- it only maps what Playwright recorded:
//   passed -> PASS; skipped with a BLOCKED outcome annotation -> BLOCKED;
//   anything else (failed, timed out, interrupted, other skips) -> FAIL.
const fs = require('node:fs');
const path = require('node:path');

class SummaryReporter {
  constructor(options = {}) {
    this.outputFolder = options.outputFolder || 'playwright-report';
    this.rows = [];
  }

  onBegin(config, suite) {
    this.suiteTitle = suite.allTests()[0]?.parent?.title || 'Playwright tests';
  }

  onTestEnd(test, result) {
    // Only the final attempt counts.
    if (result.retry < test.retries && result.status !== 'passed' && result.status !== 'skipped') return;
    const note = (type) => test.annotations.filter((a) => a.type === type).map((a) => a.description);
    const blocked = note('outcome').find((d) => d.startsWith('BLOCKED'));
    const outcome = result.status === 'passed' ? 'PASS' : result.status === 'skipped' && blocked ? 'BLOCKED' : 'FAIL';
    const reason = outcome === 'PASS' ? ''
      : blocked || note('outcome').find((d) => d.startsWith('FAIL')) || (result.errors[0]?.message || result.status).split('\n')[0];
    this.rows = this.rows.filter((r) => r.title !== test.title);
    this.rows.push({
      suite: test.parent.title,
      title: test.title,
      prompt: note('prompt')[0] || '',
      outcome,
      status: result.status,
      durationMs: result.duration,
      reason: reason.replace(/\u001b\[[0-9;]*m/g, ''),
      checks: note('check'),
    });
  }

  async onEnd(result) {
    if (!this.rows.length) return; // e.g. --list: nothing ran
    const count = (o) => this.rows.filter((r) => r.outcome === o).length;
    const totals = { total: this.rows.length, passed: count('PASS'), failed: count('FAIL'), blocked: count('BLOCKED') };
    const overall = totals.failed ? 'FAIL' : totals.blocked ? 'BLOCKED' : totals.total ? 'PASS' : 'NO TESTS';
    const mins = (ms) => `${(ms / 60000).toFixed(1)} min`;
    const lines = [
      `# ${this.suiteTitle}`,
      '',
      `**Overall: ${overall}** — ${totals.total} tests: ${totals.passed} passed, ${totals.failed} failed, ${totals.blocked} blocked (run status: ${result.status}, ${mins(result.duration)})`,
      '',
      '| Test case | Prompt | Result | Duration | Reason |',
      '| --- | --- | --- | --- | --- |',
      ...this.rows.map((r) => `| ${r.title} | ${r.prompt} | **${r.outcome}** | ${mins(r.durationMs)} | ${r.reason.replace(/\|/g, '\\|')} |`),
      '',
      ...this.rows.flatMap((r) => [`## ${r.title} — ${r.outcome}`, '', ...r.checks.map((c) => `- ${c}`), '']),
    ];
    fs.mkdirSync(this.outputFolder, { recursive: true });
    fs.writeFileSync(path.join(this.outputFolder, 'summary.md'), `${lines.join('\n')}\n`);
    fs.writeFileSync(path.join(this.outputFolder, 'summary.json'), JSON.stringify({ suite: this.suiteTitle, overall, ...totals, tests: this.rows }, null, 2));

    console.log(`\n${this.suiteTitle}`);
    for (const r of this.rows) console.log(`  ${r.outcome.padEnd(7)} ${r.title} (${mins(r.durationMs)})${r.reason ? ` — ${r.reason}` : ''}`);
    console.log(`  Overall: ${overall} — ${totals.passed}/${totals.total} passed, ${totals.failed} failed, ${totals.blocked} blocked`);
    console.log(`  Summary: ${path.join(this.outputFolder, 'summary.md')}\n`);
  }

  printsToStdio() {
    return false;
  }
}

module.exports = SummaryReporter;
