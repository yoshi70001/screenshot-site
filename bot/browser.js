import { launch } from "puppeteer";

// Default options for the Bot
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const DEFAULT_VIEWPORT = { width: 1920, height: 1080, deviceScaleFactor: 1 };
const DEFAULT_GOTO_TIMEOUT = 30000; // 30 seconds
const DEFAULT_NAVIGATION_WAIT = "networkidle2"; // Often faster and sufficient than networkidle0

/**
 * @typedef {Object} BotOptions
 * @property {import("puppeteer").LaunchOptions} [launchOptions] - Puppeteer launch options. Defaults will be merged with { headless: true }.
 * @property {string} [userAgent] - User agent string. Defaults to Googlebot.
 * @property {import("puppeteer").Viewport} [viewport] - Viewport settings. Defaults to 1920x1080.
 * @property {boolean} [optimizeLoad=false] - If true, enables request interception to potentially block resources.
 * @property {Object} [blockResources] - Specifies resource types to block if optimizeLoad is true.
 * @property {boolean} [blockResources.images=true] - Block images.
 * @property {boolean} [blockResources.css=false] - Block stylesheets.
 * @property {boolean} [blockResources.fonts=false] - Block fonts.
 */

/**
 * @typedef {Object} SetPageOptions
 * @property {import("puppeteer").PuppeteerLifeCycleEvent | import("puppeteer").PuppeteerLifeCycleEvent[]} [waitUntil] - When to consider navigation successful. Defaults to 'networkidle2'.
 * @property {number} [timeout] - Navigation timeout in milliseconds. Defaults to 30000.
 * @property {boolean} [waitForNetworkIdle=false] - Explicitly wait for network idle after initial navigation (use cautiously).
 * @property {import("puppeteer").WaitForNetworkIdleOptions} [networkIdleOptions] - Options for waitForNetworkIdle if used.
 * @property {import("puppeteer").NavigationOptions} [gotoOptions] - Additional options for page.goto().
 */

/**
 * @typedef {Object} ScreenshotOptions
 * @property {boolean} [fullPage=false] - Capture the full scrollable page. Defaults to false (viewport).
 * @property {'png' | 'jpeg' | 'webp'} [type='png'] - Image type.
 * @property {number} [quality] - Quality for 'jpeg' or 'webp' (0-100).
 * @property {import("puppeteer").ScreenshotOptions} [screenshotOptions] - Additional options for page.screenshot().
 */

class Bot {
  #browser = null;
  #page = null;
  #options; // Store combined options
  #isInterceptionEnabled = false; // Track request interception state

  /**
   * Creates an instance of the Bot.
   * @param {BotOptions} [options={}] - Configuration options for the bot.
   */
  constructor(options = {}) {
    // Merge default and user-provided options
    this.#options = {
      launchOptions: { headless: true, ...options.launchOptions },
      userAgent: options.userAgent || DEFAULT_USER_AGENT,
      viewport: options.viewport || DEFAULT_VIEWPORT,
      optimizeLoad: options.optimizeLoad ?? false,
      blockResources: {
        images: options.blockResources?.images ?? true,
        css: options.blockResources?.css ?? false,
        fonts: options.blockResources?.fonts ?? false,
        ...options.blockResources, // Allow overriding specific types
      },
    };
  }

  /**
   * Launches the Puppeteer browser and creates a new page.
   * @throws {Error} If browser launch or page creation fails.
   */
  async startBrowser() {
    if (this.#browser) {
      console.warn("Browser already started.");
      return;
    }
    try {
      this.#browser = await launch(this.#options.launchOptions);
      this.#page = await this.#browser.newPage();

      // Handle unexpected browser closure
      this.#browser.on("disconnected", () => {
        console.warn("Puppeteer browser disconnected unexpectedly.");
        this.#browser = null;
        this.#page = null;
        this.#isInterceptionEnabled = false; // Reset interception state
      });

      await this.#page.setUserAgent(this.#options.userAgent);
      await this.#page.setViewport(this.#options.viewport);

      // Setup resource blocking if requested
      if (this.#options.optimizeLoad) {
        await this.#enableResourceBlocking();
      }

      console.log("Browser started successfully.");
    } catch (error) {
      console.error("Failed to start browser:", error);
      await this.closeBrowser(); // Attempt cleanup on failure
      throw error; // Re-throw the error for external handling
    }
  }

  /**
   * Enables request interception to block specified resources.
   * @private
   */
  async #enableResourceBlocking() {
    if (!this.#page || this.#isInterceptionEnabled) return;

    try {
      await this.#page.setRequestInterception(true);
      this.#isInterceptionEnabled = true;

      this.#page.on("request", this.#handleRequestInterception);
      console.log("Resource blocking enabled.");
    } catch (error) {
      console.error("Failed to enable request interception:", error);
      this.#isInterceptionEnabled = false; // Ensure state is correct on error
    }
  }

  /**
   * Disables request interception.
   * @private
   */
  async #disableResourceBlocking() {
    if (!this.#page || !this.#isInterceptionEnabled) return;

    try {
      this.#page.off("request", this.#handleRequestInterception); // Remove listener first
      await this.#page.setRequestInterception(false);
      this.#isInterceptionEnabled = false;
      console.log("Resource blocking disabled.");
    } catch (error) {
      // Ignore errors if interception was already disabled somehow or page closed
      if (!error.message.includes("Request Interception is not enabled")) {
        console.warn("Error disabling request interception:", error);
      }
      // Ensure state is reset even on error
      this.#isInterceptionEnabled = false;
    }
  }

  /**
   * Request handler for interception. Aborts requests based on blockResources options.
   * @param {import("puppeteer").HTTPRequest} request - The intercepted request.
   * @private
   */
  #handleRequestInterception = (request) => {
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

    if (shouldBlock) {
      request
        .abort()
        .catch((err) =>
          console.warn(
            `Failed to abort request ${request.url()}: ${err.message}`
          )
        );
    } else {
      request
        .continue()
        .catch((err) =>
          console.warn(
            `Failed to continue request ${request.url()}: ${err.message}`
          )
        );
    }
  };

  /**
   * Navigates the page to a specified URL.
   * @param {string} url - The URL to navigate to.
   * @param {SetPageOptions} [options={}] - Navigation options.
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

    try {
      console.log(`Navigating to ${url} with options:`, gotoOptions);
      const response = await this.#page.goto(url, gotoOptions);
      console.log(
        `Navigation to ${url} finished with status: ${response?.status()}`
      );

      // Optional explicit wait for network idle (use carefully)
      if (options.waitForNetworkIdle) {
        console.log("Explicitly waiting for network idle...");
        await this.#page.waitForNetworkIdle({
          timeout: DEFAULT_GOTO_TIMEOUT, // Reuse default timeout
          ...(options.networkIdleOptions || {}),
        });
        console.log("Network is idle.");
      }
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

    const screenshotOptions = {
      encoding: "base64",
      fullPage: options.fullPage || false,
      type: options.type || "png",
      quality: options.quality, // Only used for jpeg/webp
      ...(options.screenshotOptions || {}), // Allow overriding specific screenshot options
    };

    try {
      const data = await this.#page.screenshot(screenshotOptions);
      return `data:image/${screenshotOptions.type};base64,${data}`;
    } catch (error) {
      console.error("Failed to take screenshot:", error);
      throw error; // Re-throw for external handling
    }
  }

  /**
   * Closes the Puppeteer browser. Safe to call multiple times.
   */
  async closeBrowser() {
    if (this.#isInterceptionEnabled) {
      // Attempt to disable cleanly if page still exists
      if (this.#page) {
        await this.#disableResourceBlocking();
      } else {
        this.#isInterceptionEnabled = false; // Just reset flag if page is gone
      }
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
        this.#isInterceptionEnabled = false;
      }
    } else {
      // console.log("Browser already closed or not started.");
    }
  }

  /**
   * Provides direct access to the Puppeteer Page object for advanced use cases.
   * @returns {import("puppeteer").Page | null} The Page object or null if not initialized.
   */
  get page() {
    return this.#page;
  }

  /**
   * Provides direct access to the Puppeteer Browser object for advanced use cases.
   * @returns {import("puppeteer").Browser | null} The Browser object or null if not initialized.
   */
  get browser() {
    return this.#browser;
  }
}

export { Bot };

// --- Example Usage ---
/*
async function runBot() {
  const bot = new Bot({
    // launchOptions: { headless: false, slowMo: 50 }, // Example: Run non-headless with slow motion
    // userAgent: "MyCustomBot/1.0",
    optimizeLoad: true, // Enable resource blocking
    blockResources: {
        images: true, // Block images (default is true when optimizeLoad is true)
        css: true,    // Also block CSS
        fonts: true   // Also block fonts
    }
  });

  try {
    await bot.startBrowser();

    await bot.setPage("https://httpbin.org/get", { // A simple page for testing blocked resources
        waitUntil: 'domcontentloaded' // Faster wait for simple pages
    });
    console.log("Page loaded.");

    const screenshotData = await bot.takeScreenshot({ fullPage: true, type: 'jpeg', quality: 80 });
    console.log("Screenshot taken (first 100 chars):", screenshotData.substring(0, 100));
    // You could save the screenshot to a file here if needed

    // Example of using the raw page object
    // const pageTitle = await bot.page.title();
    // console.log("Page Title:", pageTitle);

  } catch (error) {
    console.error("Bot encountered an error:", error);
  } finally {
    await bot.closeBrowser();
  }
}

runBot();
*/
