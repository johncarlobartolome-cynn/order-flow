// Runs via Jest `setupFiles`, BEFORE any test module (and the handler) is imported.
// The handler reads EVENT_BUS_NAME once at module load, so it must be set here,
// not in a beforeEach (which runs after the import).
process.env.EVENT_BUS_NAME = 'order-flow-bus';
process.env.TABLE_NAME = 'order-flow-table';