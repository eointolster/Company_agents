module.exports = {
  PORT_HTTP : 3000,
  PORT_WS   : 3001,
  MIN_WORKERS : 1,                              // keep at least one warm
  // Ensure MAX_WORKERS is at least 1, even if availableParallelism() is 1 or less
  MAX_WORKERS : Math.max(1, require('os').availableParallelism() - 1),
  WORKER_IDLE_MS : 5 * 60_000,                  // kill after 5 min idle
  SUMMARY_CRON  : '59 23 * * *',                // 23:59 every day
};