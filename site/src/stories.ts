export type StoryCategory = "Technology" | "Business" | "Science" | "World";

export type Story = {
  id: string;
  title: string;
  excerpt?: string;
  time?: string;
  date?: string;
  category: StoryCategory;
  detail: string;
};

export const stories: Story[] = [
  {
    id: "microsoft-arch",
    title: "Tech giant Microsoft acquires Arch Linux for $150 million",
    excerpt:
      "CEO Satya Nadella says flagship AI assistant Copilot will be introduced to the terminal later this week, following this morning's acquisition of the grassroots operating system.",
    time: "4 hours ago",
    category: "Technology",
    detail:
      "The deal includes the package repositories, the wiki and one slightly worried maintainer. Microsoft says existing installations will keep working while the paperwork is moved into a GitHub issue.",
  },
  {
    id: "bios-collection",
    title:
      "Google announces BIOS level data collection system could be rolled out by as soon as next month - even to existing computers",
    date: "July 26, 2025",
    category: "Technology",
    detail:
      "The proposed system would read a machine's firmware before the operating system starts. Google says the first release will show a clear notice, provided the computer has a working display.",
  },
  {
    id: "hyprland-meta",
    title:
      '"Year of the Linux desktop" officially ends as Hyprland tiling window manager sells out to Meta',
    time: "10 hours ago",
    category: "Business",
    detail:
      "Hyprland's new owner says the compositor will remain open source, although the default keybind for opening a sponsored panel has not been announced.",
  },
  {
    id: "proton-history",
    title: "Proton VPN under fire after leaking millions of user's search history",
    time: "12 hours ago",
    category: "Technology",
    detail:
      "The company blamed a logging flag left on during a routine migration. It has since been renamed to a more reassuring setting and moved one screen deeper into the application.",
  },
  {
    id: "fedora-roadmap",
    title: "Fedora publishes a roadmap for the roadmap after losing the first draft",
    date: "July 25, 2025",
    category: "Technology",
    detail:
      "The missing document was last seen in a shared folder called final-final-2. The new roadmap schedules a search for it before the next release freeze.",
  },
  {
    id: "steam-runtime",
    title: "Valve finds 37 copies of glibc on one test laptop and calls the result encouraging",
    time: "1 day ago",
    category: "Science",
    detail:
      "The copies were loaded by different games, launchers and one utility that only opens a settings window. Engineers stopped counting after the laptop began making a dial-up sound.",
  },
  {
    id: "kernel-todo",
    title:
      "Kernel maintainer removes the last TODO, then adds it back with a more accurate comment",
    time: "Yesterday",
    category: "Technology",
    detail:
      "The change passed review in eleven minutes. A follow-up patch now asks whether the TODO should be written in all caps for historical reasons.",
  },
  {
    id: "printer-fax",
    title: "Office printer accepts a fax from 1998 and refuses to explain how it got here",
    date: "July 22, 2025",
    category: "World",
    detail:
      "The four-page document contains a blurry lunch menu and a phone number that no longer belongs to a person. Staff have placed it beside the printer until someone claims it.",
  },
];
