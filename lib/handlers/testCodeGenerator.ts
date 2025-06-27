import { convertPlaywrightCodeToFramework } from "../inference";
import { LogLine } from "../../types/log";
import { ActionRecorder, ActionRecorderEntry } from "../cache/ActionRecorder";
import { LLMProvider } from "../llm/LLMProvider";

export class TestCodeGenerator {
  private readonly actionRecorder: ActionRecorder | undefined;
  private readonly logger: (logLine: LogLine) => void;
  private readonly llmProvider: LLMProvider;

  constructor({
    actionRecorder,
    logger,
    llmProvider,
  }: {
    actionRecorder?: ActionRecorder;
    logger: (logLine: LogLine) => void;
    llmProvider: LLMProvider;
  }) {
    this.actionRecorder = actionRecorder;
    this.logger = logger;
    this.llmProvider = llmProvider;
  }

  private _getUrlFromActions(): Promise<string> {
    if (!this.actionRecorder) {
      return Promise.resolve("");
    }
    return this.actionRecorder.getAllActions().then((actions) => {
      const sortedActions = actions.sort(
        (a, b) => (a.timestamp || 0) - (b.timestamp || 0),
      );
      this.logger({
        category: "action",
        message: "getting url from actions",
        level: 1,
        auxiliary: {
          actions: {
            value: sortedActions.map((action) => action.data.url).join(", "),
            type: "string",
          },
        },
      });
      return sortedActions.length > 0 ? sortedActions[0].data.url || "" : "";
    });
  }

  private _getRecordedActions(): Promise<ActionRecorderEntry[]> {
    if (!this.actionRecorder) {
      return Promise.resolve([]);
    }
    return this.actionRecorder
      .getAllActions()
      .then((actions) =>
        actions.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)),
      );
  }

  private _convertXPathToPlaywrightSelector(xpath: string): string {
    let playwrightSelector = xpath;
    if (xpath.startsWith("/html/body")) {
      playwrightSelector = `//body${xpath.replace("/html/body", "")}`;
    } else if (xpath.startsWith("/")) {
      playwrightSelector = `//${xpath.substring(1)}`;
    }
    return `xpath=${playwrightSelector}`;
  }

  private async _buildPythonPlaywrightCode(): Promise<string> {
    const url = await this._getUrlFromActions();

    const codeLines: string[] = [
      "from playwright.sync_api import sync_playwright",
      "",
      "def run():",
      "    with sync_playwright() as p:",
      "        browser = p.chromium.launch(headless=False)",
      "        context = browser.new_context()",
      "        page = context.new_page()",
      "",
      `        page.goto('${url}')`,
      "",
    ];

    if (!this.actionRecorder) {
      return codeLines.join("\n");
    }

    const sortedActions = await this._getRecordedActions();

    for (const action of sortedActions) {
      const data = action.data;
      const command = data.playwrightCommand;
      const xpath = data.xpaths?.[0];

      if (!xpath) {
        continue;
      }

      const playwrightSelector = this._convertXPathToPlaywrightSelector(xpath);

      if (command.method === "click") {
        codeLines.push(`        page.locator('${playwrightSelector}').click()`);
      } else if (command.method === "fill") {
        codeLines.push(
          `        page.locator('${playwrightSelector}').fill('${command.args[0]}')`,
        );
      } else if (command.method === "press") {
        codeLines.push(`        page.keyboard.press('${command.args[0]}')`);
      } else if (command.method === "type") {
        codeLines.push(
          `        page.locator('${playwrightSelector}').type('${command.args[0]}')`,
        );
      } else if (command.method === "scrollIntoView") {
        codeLines.push(
          `        page.locator('${playwrightSelector}').scrollIntoViewIfNeeded()`,
        );
      }
    }

    codeLines.push(
      ...[
        "",
        "        context.close()",
        "        browser.close()",
        "",
        "if __name__ == '__main__':",
        "    run()",
      ],
    );

    return codeLines.join("\n");
  }

  private async _buildTypescriptPlaywrightCode(): Promise<string> {
    const url = await this._getUrlFromActions();

    const codeLines: string[] = [
      "import { chromium } from '@playwright/test';",
      "",
      "async function run() {",
      "  const browser = await chromium.launch({ headless: false });",
      "  const context = await browser.newContext();",
      "  const page = await context.newPage();",
      "",
      `  await page.goto('${url}');`,
      "",
    ];

    if (!this.actionRecorder) {
      this.logger({
        category: "action",
        message: "no actions recorded",
        level: 1,
      });
      return codeLines.join("\n");
    }

    const sortedActions = await this._getRecordedActions();

    for (const action of sortedActions) {
      const data = action.data;
      const command = data.playwrightCommand;
      const xpath = data.xpaths?.[0];

      if (!xpath) {
        continue;
      }

      const playwrightSelector = this._convertXPathToPlaywrightSelector(xpath);

      if (command.method === "click") {
        codeLines.push(
          `  await page.locator('${playwrightSelector}').click();`,
        );
      } else if (command.method === "fill") {
        codeLines.push(
          `  await page.locator('${playwrightSelector}').fill('${command.args[0]}');`,
        );
      } else if (command.method === "press") {
        codeLines.push(`  await page.keyboard.press('${command.args[0]}');`);
      } else if (command.method === "type") {
        codeLines.push(
          `  await page.locator('${playwrightSelector}').type('${command.args[0]}');`,
        );
      } else if (command.method === "scrollIntoView") {
        codeLines.push(
          `  await page.locator('${playwrightSelector}').scrollIntoViewIfNeeded();`,
        );
      }
    }

    codeLines.push(
      ...[
        "",
        "  await context.close();",
        "  await browser.close();",
        "}",
        "",
        "run().catch(console.error);",
      ],
    );

    return codeLines.join("\n");
  }

  async generateCode(language: string, testFramework: string): Promise<string> {
    // Get code in requested language
    const getCodeForLanguage = async (language: string) => {
      switch (language) {
        case "typescript":
          return this._buildTypescriptPlaywrightCode();
        case "python":
          return this._buildPythonPlaywrightCode();
        default:
          throw new Error(`Unsupported language: ${language}`);
      }
    };

    // For non-Playwright frameworks, convert using LLM
    if (testFramework !== "playwright") {
      const playwrightCode = await getCodeForLanguage(language);
      return await convertPlaywrightCodeToFramework(
        playwrightCode,
        testFramework,
        this.llmProvider.getClient("gpt-4.1"),
        Math.random().toString(36).substring(2),
        this.logger,
      );
    }

    // For Playwright, return code directly
    return await getCodeForLanguage(language);
  }
}
