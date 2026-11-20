const pending = new Map();
const capturing = new Set();
const viewer = browser.runtime.getURL('export.html');

browser.browserAction.onClicked.addListener(async tab => {
  if (capturing.has(tab.id)) return;
  capturing.add(tab.id);
  const key = crypto.randomUUID();
  try {
    let result;
    try {
      const inject = file => browser.tabs.executeScript(tab.id, {file, frameId: 0, runAt: 'document_start'});
      await inject('read.js');
      await inject('reader.js');
      const [snapshot] = await inject('snapshot.js');
      if (!snapshot?.readerId) throw new Error('The source tab changed during capture. Return to the page and tap Export ZIP again.');
      result = {sourceId: tab.id, snapshot};
    } catch (error) {
      result = {error: 'Could not capture this tab. ' + error.message};
    }
    pending.set(key, result);
    await browser.tabs.create({url: viewer + '#' + key, active: true});
    setTimeout(() => pending.delete(key), 120000);
  } catch (error) {
    pending.delete(key);
    console.error('Export ZIP', error);
  } finally {
    capturing.delete(tab.id);
  }
});

browser.runtime.onMessage.addListener((message, sender) => {
  if (message.type !== 'export-zip/take' || sender.url?.split('#')[0] !== viewer) return;
  const job = pending.get(message.key);
  pending.delete(message.key);
  return Promise.resolve(job || {error: 'Return to the source tab and tap Export ZIP to start a new export.'});
});
