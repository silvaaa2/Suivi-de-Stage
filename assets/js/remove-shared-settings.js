function removeSharedSettingsUi() {
  document.getElementById("sharedSettingsBtn")?.remove();
  document.getElementById("sharedSettingsModal")?.remove();

  document.querySelectorAll(".shared-settings-btn").forEach(button => {
    button.remove();
  });
}

function installSharedSettingsRemoval() {
  if (document.getElementById("removeSharedSettingsStyles")) return;

  const style = document.createElement("style");
  style.id = "removeSharedSettingsStyles";
  style.textContent = `
    #sharedSettingsBtn,
    #sharedSettingsModal,
    .shared-settings-btn {
      display: none !important;
    }
  `;

  document.head.appendChild(style);

  window.openSharedSettingsModal = function() {
    removeSharedSettingsUi();
  };

  window.closeSharedSettingsModal = function() {
    removeSharedSettingsUi();
  };

  window.openSharedEffectifLink = function() {
    removeSharedSettingsUi();
  };

  window.openEffectifFromSharedSettings = function() {
    removeSharedSettingsUi();
  };

  removeSharedSettingsUi();

  const observer = new MutationObserver(removeSharedSettingsUi);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  window.setTimeout(removeSharedSettingsUi, 250);
  window.setTimeout(removeSharedSettingsUi, 1000);
  window.setTimeout(removeSharedSettingsUi, 2500);
}

if (document.body) {
  installSharedSettingsRemoval();
} else {
  document.addEventListener("DOMContentLoaded", installSharedSettingsRemoval, { once: true });
}
