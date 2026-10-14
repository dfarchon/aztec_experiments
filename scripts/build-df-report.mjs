import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadingReport } from '../apps/src/df-billboard-test/report-data.mjs';

// Evidence stays outside the repository. Only the public, synthetic diagnostic
// report is emitted into ignored apps/dist; no wallet/deployment data is copied.
export function buildDFReport(root, dist) {
  const directory = process.env.DF_REPORT_DOCS_DIR || path.resolve(root, '../docs');
  const files = {
    original: 'moderation-evaluation-2026-10-13/samples.json',
    holdout: 'moderation-evaluation-v3/holdout.json',
    browser: 'moderation-model-comparison-2026-10-14/horizon-browser-results.json',
    native: 'moderation-model-comparison-2026-10-14/horizon-results.json',
  };
  let report;
  try {
    const inputs = {}, sources = [];
    for (const [name, file] of Object.entries(files)) {
      const bytes = fs.readFileSync(path.join(directory, file));
      inputs[name] = JSON.parse(bytes);
      sources.push({ file, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    report = { ...createReadingReport({ ...inputs, metadata: inputs.native.metadata }), sources };
  } catch (error) {
    // A fresh checkout without the local research folder must still build.
    report = { available: false, error: error.code === 'ENOENT' ? '未找到外部测试资料。' : '测试资料校验失败，未展示统计数字。' };
    console.warn(`DF report unavailable: ${error.message}`);
  }
  fs.writeFileSync(path.join(dist, 'df-test-report.json'), JSON.stringify(report, null, 2) + '\n');
}
