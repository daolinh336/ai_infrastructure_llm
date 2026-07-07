import { writeMetricsReports } from '../src/metrics/metrics.js';

const reports = await writeMetricsReports();
console.log(`Metrics summary: ${reports.summaryPath}`);
console.log(`LLM call report: ${reports.llmReportPath}`);
