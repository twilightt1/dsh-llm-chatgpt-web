/**
 * Dev-only DOM probe: dump composer candidates on Temporary Chat.
 *   node --import tsx/esm scripts/debug-dom.ts
 */
import { chromium } from 'playwright-core'
import { join } from 'node:path'

const profileDir = `${process.env['HOME']}/.dsh-chatgpt-web`
const brave = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'

const browser = await chromium.launch({
  executablePath: brave,
  headless: false,
  args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
  ignoreDefaultArgs: ['--enable-automation'],
})
const context = await browser.newContext({
  storageState: join(profileDir, 'storage-state.json'),
})
await context.addInitScript({ content: `(() => { try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch {} })()` })
const page = await context.newPage()
await page.goto('https://chatgpt.com/?temporary-chat=true', { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForTimeout(8_000)

const dump = await page.evaluate(`(() => {
  const out = [];
  const push = (label, el) => { out.push('=== ' + label + ' ===\\n' + el.outerHTML.slice(0, 600)); };
  document.querySelectorAll('[contenteditable="true"]').forEach((el, i) => push('contenteditable[' + i + ']', el));
  document.querySelectorAll('textarea').forEach((el, i) => push('textarea[' + i + ']', el));
  document.querySelectorAll('[role="textbox"]').forEach((el, i) => push('role=textbox[' + i + ']', el));
  document.querySelectorAll('[data-testid*="prompt"], [data-testid*="composer"], [data-testid*="send"], [data-testid*="stop"]')
    .forEach((el) => push('testid:' + el.getAttribute('data-testid'), el));
  return out.join('\\n\\n');
})()`)
console.log(dump || '(no candidates found)')
await page.waitForTimeout(20_000)
await browser.close()
