import { useLang } from "../../lib/i18n";
import type { ActionMode } from "../../types";
import { ImageIcon, MessageIcon, VideoIcon } from "./Icons";

// The three routing gates on relay_muses (cap_chat / cap_image / cap_video).
// Shown in the Add-Muse wizard and the muse Edit dialog; callers enforce that
// at least one stays on so the direct channel keeps a usable composer tab.
export interface MuseCaps {
  cap_chat: boolean;
  cap_image: boolean;
  cap_video: boolean;
}

export function capsToAllowedModes(caps: MuseCaps): ActionMode[] {
  return (
    [
      ["chat", caps.cap_chat],
      ["image", caps.cap_image],
      ["video", caps.cap_video],
    ] as [ActionMode, boolean][]
  )
    .filter(([, on]) => on)
    .map(([mode]) => mode);
}

export function CapsPicker(props: {
  caps: MuseCaps;
  onChange: (next: MuseCaps) => void;
}) {
  const { t } = useLang();
  const items: { key: keyof MuseCaps; label: string; icon: JSX.Element }[] = [
    { key: "cap_chat", label: t("composer.tabChat"), icon: <MessageIcon size={13} /> },
    { key: "cap_image", label: t("composer.tabImage"), icon: <ImageIcon size={13} /> },
    { key: "cap_video", label: t("composer.tabVideo"), icon: <VideoIcon size={13} /> },
  ];
  return (
    <div className="caps-picker">
      {items.map((item) => (
        <label key={item.key} className="caps-item">
          <input
            type="checkbox"
            checked={props.caps[item.key]}
            onChange={() =>
              props.onChange({ ...props.caps, [item.key]: !props.caps[item.key] })
            }
          />
          <span className="caps-item-icon" aria-hidden="true">
            {item.icon}
          </span>
          <span>{item.label}</span>
        </label>
      ))}
    </div>
  );
}
