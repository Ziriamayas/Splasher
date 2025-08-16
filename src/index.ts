// Splasher (Revenge port)
// - Encodes "BNR<id>" into bio using private-use codepoints
// - Replaces banner at render time to Imgur URL
// - Uploads selected banner to Imgur on setPendingBanner
// - Spoofs Nitro preview for edit screen, switches to Nitro action sheet
//
// Notes:
// * This tries to import Vendetta shims first (common in Revenge builds).
// * If your environment provides different module locators, adapt resolve().

let patches: Array<() => void> = [];

// Try resolving Vendetta-like helpers; fail soft if not available
function safe<T>(fn: () => T, label: string): T | undefined {
  try {
    const v = fn();
    if (!v) console.log(`[Splasher] ${label} not found`);
    return v;
  } catch (e) {
    console.log(`[Splasher] ${label} lookup failed`, e);
    return undefined;
  }
}

let findByName: any, findByProps: any, findByStoreName: any;
let before: any, after: any, instead: any;
let getAssetIDByName: any, showToast: any;

(function resolve() {
  try {
    // Vendetta-style
    ({ findByName, findByProps, findByStoreName } = require("@vendetta/metro"));
  } catch {}
  try {
    ({ before, after, instead } = require("@vendetta/patcher"));
  } catch {}
  try {
    ({ getAssetIDByName } = require("@vendetta/ui/assets"));
  } catch {}
  try {
    ({ showToast } = require("@vendetta/ui/toasts"));
  } catch {}

  // Fallback no-ops to avoid crashes if missing
  findByName ||= (() => undefined);
  findByProps ||= (() => undefined);
  findByStoreName ||= (() => undefined);
  before ||= (() => () => {});
  after ||= (() => () => {});
  instead ||= (() => () => {});
  getAssetIDByName ||= (() => 0);
  showToast ||= ((msg: string) => console.log("[Splasher]", msg));
})();

// Regex that matches encoded "BNR<id>" in bio (encoded to private-use plane)
const bannerRegex =
  /\u{e0042}\u{e004E}\u{e0052}\u{e003C}([\u{e0061}-\u{e007A}\u{e0041}-\u{e005a}\u{e0030}-\u{e0039}]+?)\u{e003E}/u;

// Encode ASCII into private-use area so it's invisible in bio
const encode = (text: string) => {
  const codePoints = [...text].map(c => c.codePointAt(0)!);
  const out: string[] = [];
  for (const cp of codePoints) {
    out.push(String.fromCodePoint(cp + (0x00 < cp && cp < 0x7f ? 0xe0000 : 0)));
  }
  return out.join("");
};

export default {
  onLoad() {
    let pendingID: string | null = null;

    const ProfileBanner = safe(() => findByName("ProfileBanner", false), "ProfileBanner");
    const EditUserProfileBanner = safe(() => findByName("EditUserProfileBanner", false), "EditUserProfileBanner");
    const ChangeBannerActionSheet = safe(() => findByName("ChangeBannerActionSheet", false), "ChangeBannerActionSheet");

    const UserProfileStore = safe(() => findByProps("getUserProfile"), "UserProfileStore");
    const UserSettingsAccountStore = safe(() => findByProps("saveProfileChanges", "setPendingBanner"), "UserSettingsAccountStore");
    const Clipboard = safe(() => findByProps("setString"), "Clipboard");
    const Dialog = safe(() => findByProps("show", "openLazy", "close"), "Dialog");
    const Users = safe(() => findByStoreName("UserStore"), "UserStore");

    // 1) Strip encoded tag from bio into .banner on profile fetch
    if (UserProfileStore?.getUserProfile) {
      patches.push(
        after("getUserProfile", UserProfileStore, (_args: any[], res: any) => {
          try {
            if (!res) return res;
            const m = typeof res.bio === "string" ? res.bio.match(bannerRegex) : null;
            if (m) {
              res.banner = m[0];
              res.bio = res.bio.replace(bannerRegex, "");
            }
          } catch {}
          return res;
        })
      );
    }

    // 2) At render time, replace encoded banner with actual Imgur URL
    if (ProfileBanner?.default || ProfileBanner) {
      patches.push(
        before("default", ProfileBanner, (args: any[]) => {
          try {
            const src = args?.[0]?.bannerSource;
            const uri: string | undefined = src?.uri;
            if (!uri) return;
            const match = uri.match(bannerRegex);
            if (!match) return;

            const decoded = [...match[0]]
              .map(x => String.fromCodePoint((x.codePointAt(0) || 0) - 0xe0000))
              .join(""); // "BNR<abc123>"
            const imgurId = decoded.slice(4, -1);
            if (imgurId) {
              args[0].bannerSource.uri = `https://i.imgur.com/${imgurId}.png`;
            }
          } catch {}
        })
      );
    }

    // 3) Upload new banner to Imgur before saving (avoid race)
    if (UserSettingsAccountStore?.setPendingBanner) {
      patches.push(
        before("setPendingBanner", UserSettingsAccountStore, (args: any[]) => {
          try {
            if (args?.[0] == null) return;
            const base64 = String(args[0]).split(",")[1];
            if (!base64) return;

            const formData = new FormData();
            formData.append("image", base64);

            fetch("https://api.imgur.com/3/image", {
              method: "POST",
              body: formData,
              headers: { Authorization: `Client-ID ${__IMGUR_CLIENT_ID__}` }
            })
              .then(r => r.json())
              .then(out => {
                pendingID = out?.data?.id || null;
                if (pendingID) {
                  try {
                    showToast("Banner uploaded!", getAssetIDByName("ic_add_tier_40px"));
                  } catch {}
                }
              })
              .catch(() => {
                pendingID = null;
              });
          } catch {}
        })
      );
    }

    // 4) Intercept saveProfileChanges to inject encoded tag into bio
    if (UserSettingsAccountStore?.saveProfileChanges) {
      patches.push(
        instead("saveProfileChanges", UserSettingsAccountStore, function (args: any[], orig: Function) {
          try {
            const currentUserId = Users?.getCurrentUser?.()?.id;
            const currentProfile = currentUserId ? UserProfileStore?.getUserProfile?.(currentUserId) : undefined;
            const currentBio = args?.[0]?.bio !== undefined ? args[0].bio : currentProfile?.bio;

            // If banner cleared, keep the stripped bio
            if (args?.[0]?.banner === null) {
              args[0].bio = currentBio;
              return orig.apply(this, args);
            }

            const hasExistingEncoded = currentProfile?.banner?.match?.(bannerRegex);
            if (!(args?.[0]?.banner || hasExistingEncoded)) {
              return orig.apply(this, args);
            }

            // Block save until Imgur upload finishes
            if (args?.[0]?.banner && !pendingID) {
              try {
                showToast("Hold on, uploading banner…", getAssetIDByName("ic_clock_timeout_16px"));
              } catch {}
              return;
            }

            const encodedInfo = pendingID ? encode(`BNR<${pendingID}>`) : currentProfile?.banner;
            const insertedBio = (currentBio || "") + (encodedInfo || "");

            // Conservative bio limit (190 like original port)
            if (insertedBio.length > 190) {
              try { Clipboard?.setString?.(encodedInfo || ""); } catch {}
              try {
                Dialog?.show?.({
                  title: "Not enough space",
                  body: `Your bio is too long to include the banner tag. Clear ${(encodedInfo?.length || 0)} characters and try again. The tag has been copied to your clipboard.`
                });
              } catch {}
              return;
            }

            args[0].bio = insertedBio;
            pendingID = null;
            return orig.apply(this, args);
          } catch {
            return orig.apply(this, args);
          }
        })
      );
    }

    // 5) Spoof Nitro in editor for preview only
    if (EditUserProfileBanner?.default) {
      patches.push(
        instead("default", EditUserProfileBanner, function (args: any[], orig: Function) {
          try {
            const u = args?.[0]?.user;
            const prev = u?.premiumType;
            if (u) u.premiumType = 2;
            const res = orig.apply(this, args);
            if (u) u.premiumType = prev;
            return res;
          } catch {
            return orig.apply(this, args);
          }
        })
      );
    }

    // 6) Force Nitro action sheet UI to allow banner selection
    if (ChangeBannerActionSheet?.default) {
      patches.push(
        before("default", ChangeBannerActionSheet, (args: any[]) => {
          try { if (args?.[0]) args[0].isTryItOut = true; } catch {}
        })
      );
    }

    try { showToast("Splasher loaded ✓", getAssetIDByName("ic_check")); } catch {}
  },

  onUnload() {
    for (const un of patches) {
      try { un(); } catch {}
    }
    patches = [];
    try { showToast("Splasher unloaded", getAssetIDByName("ic_call_end")); } catch {}
  }
};