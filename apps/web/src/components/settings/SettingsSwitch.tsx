export function SettingsSwitch({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
        checked ? "bg-[#2b1a10]" : "bg-[#ded8d0]"
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
          checked ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </span>
  );
}
