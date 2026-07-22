module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['@swc/jest']
  },
  // Runs before test modules are imported, so env vars the handler reads at
  // module load (e.g. EVENT_BUS_NAME) are already set.
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  setupFilesAfterEnv: ['aws-cdk-lib/testhelpers/jest-autoclean'],
};
