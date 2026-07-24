const stats = {
  startTime: Date.now(),
  jobsScanned: 0,
  matchesFound: 0,
  proposalsSubmitted: 0,
  proposalsRejected: 0,
  lastCheckedConnects: null,
  isPaused: false,
  isScraping: false
};

module.exports = {
  getStats() {
    return { ...stats };
  },
  incrementScanned(count = 1) {
    stats.jobsScanned += count;
  },
  incrementMatches(count = 1) {
    stats.matchesFound += count;
  },
  incrementSubmitted(count = 1) {
    stats.proposalsSubmitted += count;
  },
  incrementRejected(count = 1) {
    stats.proposalsRejected += count;
  },
  setConnects(balance) {
    stats.lastCheckedConnects = balance;
  },
  isPaused() {
    return stats.isPaused;
  },
  setPaused(val) {
    stats.isPaused = !!val;
  },
  isScraping() {
    return stats.isScraping;
  },
  setScraping(val) {
    stats.isScraping = !!val;
  }
};
