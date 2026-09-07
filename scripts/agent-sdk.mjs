import { chromium } from 'playwright';
import { AgentError, PillowfortBrowserAgent } from './agent-browser.mjs';

export { AgentError, errorResult, boundedJSON, validateBaseURL, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES, MAX_WAIT_MS } from './agent-browser.mjs';

/** Public local SDK: installs and launches the matching Node Playwright browser. */
export class PillowfortAgent extends PillowfortBrowserAgent {
  /** @param {Omit<import('./agent-browser.mjs').BrowserAgentOptions, 'launchBrowser'> & {headed?: boolean}} options */
  constructor({ headed = false, ...options } = {}) {
    super({
      ...options,
      launchBrowser: async ({ timeout }) => {
        try { return await chromium.launch({ headless: !headed, timeout }); }
        catch {
          throw new AgentError('BROWSER_UNAVAILABLE', 'Chromium could not start. Run pillowfort-agent install-browser (source: node scripts/agent.mjs install-browser) to install the matching browser, then check OS browser dependencies and headed display availability.', true);
        }
      },
    });
  }
}
