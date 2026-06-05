const { clerkSetup } = require('@clerk/testing/playwright');

module.exports = async function globalSetup() {
  await clerkSetup();
};
