/** @param {'readonly' | 'dml' | 'http' | 'auth' | 'companies' | 'companies-write' | 'invitations'} phase */
exports.registerConnectedSuite = function (phase) {
  // Deferred synchronous import: Jest requires describe/test registration synchronously.
  require('./connected').registerConnectedSuite(phase);
};
exports.loadedDatabaseModules = function () {
  return Object.keys(require.cache).filter(path => /node_modules[/\\](pg|typeorm)[/\\]/.test(path));
};
