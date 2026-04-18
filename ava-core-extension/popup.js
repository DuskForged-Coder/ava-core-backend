const activateButton = document.getElementById("activate-assistant");
const statusText = document.getElementById("status");

function updateStatus(message) {
  statusText.textContent = message;
}

activateButton.addEventListener("click", () => {
  updateStatus("Activating assistant...");

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs[0];

    if (!activeTab?.id) {
      updateStatus("No active tab found.");
      return;
    }

    chrome.scripting.insertCSS(
      {
        target: { tabId: activeTab.id },
        files: ["styles.css"]
      },
      () => {
        const cssError = chrome.runtime.lastError;
        if (cssError) {
          updateStatus(`Could not inject styles: ${cssError.message}`);
          return;
        }

        chrome.scripting.executeScript(
          {
            target: { tabId: activeTab.id },
            files: ["content.js"]
          },
          () => {
            const scriptError = chrome.runtime.lastError;

            if (scriptError) {
              updateStatus(`Could not activate assistant: ${scriptError.message}`);
              return;
            }

            chrome.scripting.executeScript(
              {
                target: { tabId: activeTab.id },
                func: () => {
                  const root = document.getElementById("ava-core-root");
                  const panel = root?.querySelector(".ava-core-panel");
                  const input = root?.querySelector(".ava-core-input");
                  const avatarButton = root?.querySelector(".ava-core-avatar-button");

                  panel?.classList.add("ava-core-panel-open");
                  panel?.setAttribute("aria-hidden", "false");
                  avatarButton?.classList.add("ava-core-avatar-active");
                  input?.focus();
                }
              },
              () => {
                const openError = chrome.runtime.lastError;

                if (openError) {
                  updateStatus(`Assistant injected, but could not open it: ${openError.message}`);
                  return;
                }

                updateStatus("Assistant activated on the current tab.");
              }
            );
          }
        );
      }
    );
  });
});
