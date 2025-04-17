// playwright-bot.js
import { chromium, firefox, webkit } from "playwright"; // Import desired browsers

// --- Type Definitions (Adjusted for Playwright) ---
/**
 * @typedef {import("playwright").Browser} Browser
 * @typedef {import("playwright").Page} Page
 * @typedef {import("playwright").Route} Route
 * @typedef {import("playwright").Request} Request
 * @typedef {import("playwright").Response} Response
 * @typedef {import("playwright").BrowserContext} BrowserContext // Often used, though not directly here yet
 * @typedef {import("playwright").LaunchOptions} LaunchOptions
 * @typedef {import("playwright").ViewportSize} ViewportSize
 * @typedef {import("playwright").PageGotoOptions} PageGotoOptions
 * @typedef {import("playwright").PageScreenshotOptions} PageScreenshotOptions
 * @typedef {'load' | 'domcontentloaded' | 'networkidle' | 'commit'} WaitUntilState
 * @typedef {import("playwright").PageWaitForLoadStateOptions} PageWaitForLoadStateOptions
 */

// Default options for the Bot
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const DEFAULT_VIEWPORT = { width: 1920, height: 1080 }; // Playwright ViewportSize doesn't include deviceScaleFactor directly in the main type like Puppeteer's Viewport
const DEFAULT_GOTO_TIMEOUT = 30000; // 30 seconds
const DEFAULT_NAVIGATION_WAIT = "networkidle"; // Playwright's equivalent, often robust

/**
 * @typedef {Object} BotOptions
 * @property {LaunchOptions} [launchOptions] - Playwright launch options. Defaults will be merged with { headless: true }.
 * @property {'chromium' | 'firefox' | 'webkit'} [browserType='chromium'] - Type of browser to launch.
 * @property {string} [userAgent] - User agent string. Defaults to Googlebot.
 * @property {ViewportSize} [viewport] - Viewport settings. Defaults to 1920x1080.
 * @property {boolean} [optimizeLoad=false] - If true, enables request routing to potentially block resources.
 * @property {Object} [blockResources] - Specifies resource types to block if optimizeLoad is true.
 * @property {boolean} [blockResources.images=true] - Block images.
 * @property {boolean} [blockResources.css=false] - Block stylesheets.
 * @property {boolean} [blockResources.fonts=false] - Block fonts.
 */

/**
 * @typedef {Object} SetPageOptions
 * @property {WaitUntilState} [waitUntil] - When to consider navigation successful. Defaults to 'networkidle'.
 * @property {number} [timeout] - Navigation timeout in milliseconds. Defaults to 30000.
 * @property {boolean} [waitForNetworkIdle=false] - Explicitly wait for network idle after initial navigation (use cautiously).
 * @property {PageWaitForLoadStateOptions} [networkIdleOptions] - Options for waitForLoadState('networkidle') if used.
 * @property {PageGotoOptions} [gotoOptions] - Additional options for page.goto().
 */

/**
 * @typedef {Object} ScreenshotOptions
 * @property {boolean} [fullPage=false] - Capture the full scrollable page. Defaults to false (viewport).
 * @property {'png' | 'jpeg'} [type='png'] - Image type (Playwright screenshot supports png/jpeg).
 * @property {number} [quality] - Quality for 'jpeg' (0-100).
 * @property {PageScreenshotOptions} [screenshotOptions] - Additional options for page.screenshot().
 */

class Bot {
  /** @type {Browser | null} */
  #browser = null;
  /** @type {Page | null} */
  #page = null;
  /** @type {Required<BotOptions>} */ // Use Required to ensure all properties exist after merge
  #options;
  #isRoutingEnabled = false; // Track request routing state

  /**
   * Creates an instance of the Bot.
   * @param {BotOptions} [options={}] - Configuration options for the bot.
   */
  constructor(options = {}) {
    // Merge default and user-provided options
    this.#options = {
      launchOptions: { headless: true, ...options.launchOptions },
      browserType: options.browserType || 'chromium',
      userAgent: options.userAgent || DEFAULT_USER_AGENT,
      viewport: options.viewport || DEFAULT_VIEWPORT,
      optimizeLoad: options.optimizeLoad ?? false,
      blockResources: {
        images: options.blockResources?.images ?? true,
        css: options.blockResources?.css ?? false,
        fonts: options.blockResources?.fonts ?? false,
        ...(options.blockResources || {}), // Allow overriding specific types
      },
    };
  }

  /**
   * Launches the Playwright browser and creates a new page.
   * @throws {Error} If browser launch or page creation fails.
   */
  async startBrowser() {
    if (this.#browser) {
      console.warn("Browser already started.");
      return;
    }
    try {
      const browserLauncher = { chromium, firefox, webkit }[this.#options.browserType];
      if (!browserLauncher) {
          throw new Error(`Unsupported browser type: ${this.#options.browserType}`);
      }

      this.#browser = await browserLauncher.launch(this.#options.launchOptions);
      this.#page = await this.#browser.newPage({ // Pass viewport and userAgent during creation for efficiency
          userAgent: this.#options.userAgent,
          viewport: this.#options.viewport, // Playwright uses viewport directly here
      });

      // Handle unexpected browser closure
      this.#browser.on("disconnected", () => {
        console.warn("Playwright browser disconnected unexpectedly.");
        this.#browser = null;
        this.#page = null;
        this.#isRoutingEnabled = false; // Reset routing state
      });

      // No need to set userAgent/viewport again as they were set on page creation

      // Setup resource blocking if requested
      if (this.#options.optimizeLoad) {
        await this.#setupResourceBlocking();
      }

      console.log(`Browser (${this.#options.browserType}) started successfully.`);
    } catch (error) {
      console.error("Failed to start browser:", error);
      await this.closeBrowser(); // Attempt cleanup on failure
      throw error; // Re-throw the error for external handling
    }
  }

  /**
   * Enables request routing to block specified resources.
   * @private
   */
  async #setupResourceBlocking() {
    if (!this.#page || this.#isRoutingEnabled) return;

    try {
      // Use page.route to intercept requests. '**/*' matches all URLs.
      await this.#page.route('**/*', this.#handleRequestRouting);
      this.#isRoutingEnabled = true;
      console.log("Resource blocking (routing) enabled.");
    } catch (error) {
      console.error("Failed to enable request routing:", error);
      this.#isRoutingEnabled = false; // Ensure state is correct on error
    }
  }

  /**
   * Disables request routing.
   * @private
   */
  async #removeResourceBlocking() {
    if (!this.#page || !this.#isRoutingEnabled) return;

    try {
      // Must pass the *same handler function* used in page.route
      await this.#page.unroute('**/*', this.#handleRequestRouting);
      this.#isRoutingEnabled = false;
      console.log("Resource blocking (routing) disabled.");
    } catch (error) {
        // Ignore errors if page is closing or routing already disabled
        if (!error.message.includes('Page closed') && !error.message.includes('has been closed')) {
             console.warn("Error disabling request routing:", error);
        }
      // Ensure state is reset even on error
      this.#isRoutingEnabled = false;
    }
  }

  /**
   * Request handler for routing. Aborts requests based on blockResources options.
   * Needs to be an arrow function property to maintain 'this' context and
   * provide a stable reference for unroute.
   * @param {Route} route - The route object.
   * @param {Request} request - The request object.
   * @private
   */
  #handleRequestRouting = async (route, request) => {
    const resourceType = request.resourceType();
    const blockSettings = this.#options.blockResources;
    let shouldBlock = false;

    if (
      (blockSettings.images && resourceType === "image") ||
      (blockSettings.css && resourceType === "stylesheet") ||
      (blockSettings.fonts && resourceType === "font")
    ) {
      shouldBlock = true;
    }

    try {
        if (shouldBlock) {
            await route.abort();
        } else {
            await route.continue();
        }
    } catch (error) {
        // Ignore errors if the page is closing during the async operation
        if (!error.message.includes('Target closed') && !error.message.includes('Page closed')) {
            console.warn(`Error processing request ${request.url()}: ${error.message}`);
        }
    }
  };


  /**
   * Navigates the page to a specified URL.
   * @param {string} url - The URL to navigate to.
   * @param {SetPageOptions} [options={}] - Navigation options.
   * @returns {Promise<Response | null>} The main resource response.
   * @throws {Error} If navigation fails or page is not available.
   */
  async setPage(url, options = {}) {
    if (!this.#page) {
      throw new Error("Browser not started or page not available.");
    }

    const gotoOptions = {
      waitUntil: options.waitUntil || DEFAULT_NAVIGATION_WAIT,
      timeout: options.timeout || DEFAULT_GOTO_TIMEOUT,
      ...(options.gotoOptions || {}), // Allow overriding specific goto options
    };

    let response = null;
    try {
      console.log(`Navigating to ${url} with options:`, gotoOptions);
      response = await this.#page.goto(url, gotoOptions);
      console.log(
        `Navigation to ${url} finished with status: ${response?.status() ?? 'N/A'}`
      );

      // Optional explicit wait for network idle (use carefully)
      if (options.waitForNetworkIdle) {
        console.log("Explicitly waiting for network idle...");
        await this.#page.waitForLoadState('networkidle', {
            timeout: options.networkIdleOptions?.timeout ?? DEFAULT_GOTO_TIMEOUT, // Reuse default timeout or use specific one
             ...(options.networkIdleOptions || {}),
        });
        console.log("Network is idle.");
      }
      return response;
    } catch (error) {
      console.error(`Failed to navigate to ${url}:`, error);
      throw error; // Re-throw for external handling
    }
  }

  /**
   * Takes a screenshot of the current page.
   * @param {ScreenshotOptions} [options={}] - Screenshot options.
   * @returns {Promise<string>} A Promise resolving to the Base64 encoded image data URI.
   * @throws {Error} If screenshot fails or page is not available.
   */
  async takeScreenshot(options = {}) {
    if (!this.#page) {
      throw new Error("Browser not started or page not available.");
    }

    // Map options (Playwright doesn't use 'encoding' directly for base64 buffer)
    const screenshotOptions = {
      fullPage: options.fullPage || false,
      type: options.type || "png",
      quality: options.quality, // Only used for jpeg
      timeout: DEFAULT_GOTO_TIMEOUT, // Add a reasonable timeout
      ...(options.screenshotOptions || {}), // Allow overriding specific screenshot options
    };

    // Remove invalid options for Playwright screenshot if they exist
    delete screenshotOptions.encoding;

    try {
      // Get the screenshot as a buffer
      const buffer = await this.#page.screenshot(screenshotOptions);
      // Convert buffer to base64 string
      const base64Data = buffer.toString("base64");
      return `data:image/${screenshotOptions.type};base64,${base64Data}`;
    } catch (error) {
      console.error("Failed to take screenshot:", error);
      throw error; // Re-throw for external handling
    }
  }

  /**
   * Closes the Playwright browser. Safe to call multiple times.
   */
  async closeBrowser() {
    // Attempt to disable routing cleanly before closing
    if (this.#isRoutingEnabled && this.#page) {
        // Check if page is still open before trying to unroute
        if (!this.#page.isClosed()) {
            await this.#removeResourceBlocking();
        } else {
             this.#isRoutingEnabled = false; // Just reset flag if page is gone
        }
    } else {
        this.#isRoutingEnabled = false; // Ensure flag is reset
    }


    if (this.#browser) {
      console.log("Closing browser...");
      try {
        await this.#browser.close();
        console.log("Browser closed successfully.");
      } catch (error) {
        console.error("Error closing browser:", error);
        // Log error but don't throw, as the primary goal is cleanup
      } finally {
        // Ensure references are cleared even if close fails
        this.#browser = null;
        this.#page = null;
        this.#isRoutingEnabled = false;
      }
    } else {
       // console.log("Browser already closed or not started.");
    }
  }

  /**
   * Provides direct access to the Playwright Page object for advanced use cases.
   * @returns {Page | null} The Page object or null if not initialized.
   */
  get page() {
    return this.#page;
  }

  /**
   * Provides direct access to the Playwright Browser object for advanced use cases.
   * @returns {Browser | null} The Browser object or null if not initialized.
   */
  get browser() {
    return this.#browser;
  }
}

// --- Example Usage ---
async function runBot() {
  const bot = new Bot({
    // browserType: 'firefox', // Example: Use Firefox
    // launchOptions: { headless: false, slowMo: 50 }, // Example: Run non-headless with slow motion
    // userAgent: "MyCustomBot/1.0",
    optimizeLoad: true, // Enable resource blocking
    blockResources: {
      images: true,
      css: true,
      fonts: true
    }
  });

  try {
    await bot.startBrowser();

    // Navigate to a page - httpbin is good for seeing request details
    await bot.setPage("https://httpbin.org/get", {
        waitUntil: 'domcontentloaded' // Faster wait for this simple API page
    });
    console.log("Page loaded.");

    // Example: Get content (if needed, though blocking might affect it)
    // if (bot.page && !bot.page.isClosed()) {
    //   const content = await bot.page.textContent('body');
    //   console.log("Page content (might be minimal due to blocking):", content?.substring(0, 200));
    // }

    // Take a screenshot
    const screenshotData = await bot.takeScreenshot({ fullPage: false, type: 'jpeg', quality: 80 });
    console.log("Screenshot taken (first 100 chars):", screenshotData.substring(0, 100));
    // import fs from 'fs';
    // fs.writeFileSync('screenshot.jpg', Buffer.from(screenshotData.split(',')[1], 'base64'));


    // Example of using the raw page object
    // if (bot.page && !bot.page.isClosed()) {
    //     const pageTitle = await bot.page.title();
    //     console.log("Page Title:", pageTitle); // Title might be basic on httpbin
    // }


  } catch (error) {
    console.error("Bot encountered an error:", error);
  } finally {
    await bot.closeBrowser();
  }
}

// To run the example:
// 1. Save the code as playwright-bot.js
// 2. Run `npm install playwright` or `yarn add playwright`
// 3. Make sure node version supports async/await and private class fields (Node >= 14 recommended)
// 4. Uncomment the `runBot();` line below
// 5. Run `node playwright-bot.js`

// runBot();

export { Bot }; // Export the class