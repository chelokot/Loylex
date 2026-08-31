import type { FormEvent, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { type Story, type StoryCategory, stories } from "./stories";
import "./styles.css";

const ARCH_PATH =
  "M105.8125 16.625c-7.39687 18.135158-11.858304 29.997682-20.09375 47.59375 5.04936 5.35232 11.247211 11.585364 21.3125 18.625-10.821173-4.45375-18.203557-8.92423-23.71875-13.5625-10.5398 21.992913-27.052336 53.32084-60.5625 113.53125 26.337628-15.20533 46.754089-24.57932 65.78125-28.15625-.817034-3.51405-1.2825-7.31491-1.25-11.28125l.03125-.84375c.417917-16.87382 9.195665-29.84979 19.59375-28.96875 10.39809.88104 18.48041 15.28242 18.0625 32.15625-.0786 3.17512-.43674 6.22955-1.0625 9.0625 18.82058 3.68164 39.01873 13.03179 65 28.03125-5.123-9.4318-9.69572-17.93388-14.0625-26.03125-6.87839-5.33121-14.05289-12.2698-28.6875-19.78125 10.05899 2.61375 17.2611 5.62932 22.875 9C124.63297 63.338161 121.03766 52.354109 105.8125 16.625z";

const categoryNames: Array<StoryCategory | "All stories"> = [
  "All stories",
  "Technology",
  "Business",
  "Science",
  "World",
];

const markDots = Array.from({ length: 18 }, (_, index) => {
  const angle = (index / 18) * Math.PI * 2 - Math.PI / 2;
  const radius = index % 2 === 0 ? 17.5 : 19.5;
  return {
    cx: 24 + Math.cos(angle) * radius,
    cy: 24 + Math.sin(angle) * radius,
    r: index % 2 === 0 ? 2.35 : 1.8,
  };
});

function ReutersMark() {
  return (
    <svg className="reuters-mark" viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="24" cy="24" r="2.5" fill="currentColor" />
      {markDots.map((dot) => (
        <circle key={dot.cx.toFixed(3)} cx={dot.cx} cy={dot.cy} r={dot.r} fill="currentColor" />
      ))}
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 38 38" aria-hidden="true">
      <circle cx="16.5" cy="16.5" r="11.5" fill="none" stroke="currentColor" strokeWidth="2.8" />
      <path
        d="m25 25 9 9"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2.8"
      />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg viewBox="0 0 36 36" aria-hidden="true">
      <path d="M4 8h28M4 18h28M4 28h28" fill="none" stroke="currentColor" strokeWidth="2.5" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path
        d="m6 6 20 20M26 6 6 26"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2.5"
      />
    </svg>
  );
}

function BookmarkIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M6.5 3.5h11a1 1 0 0 1 1 1v16l-6.5-3.7-6.5 3.7v-16a1 1 0 0 1 1-1Z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}

function ArchArtwork() {
  return (
    <svg
      className="arch-art"
      viewBox="0 0 664 720"
      role="img"
      aria-label="Arch Linux logo over four colored panels"
    >
      <title>Arch Linux logo</title>
      <rect width="664" height="720" fill="#f5f5f5" />
      <rect x="0" y="38" width="302" height="306" fill="#f34e16" />
      <rect x="372" y="38" width="292" height="306" fill="#73b017" />
      <rect x="0" y="370" width="318" height="335" fill="#0a9edc" />
      <rect x="342" y="370" width="322" height="335" fill="#fcb503" />
      <path
        d={ARCH_PATH}
        transform="translate(-58.5 -59) scale(3.7 3.55)"
        fill="#f5f5f5"
        fillRule="evenodd"
        stroke="#f5f5f5"
        strokeLinejoin="round"
        strokeWidth="8"
      />
      <path
        d={ARCH_PATH}
        transform="translate(-58.5 -59) scale(3.7 3.55)"
        fill="#0793d1"
        fillRule="evenodd"
      />
      <path
        d="M333 310c-22 0-39 19-39 40 0 3 0 6 1 8h86c1-2 1-5 1-8 0-21-20-40-49-40Z"
        fill="#f5f5f5"
      />
    </svg>
  );
}

function StoryMeta({ story }: { story: Story }) {
  return <p className="story-meta">{story.time ?? story.date}</p>;
}

function StoryModal({
  story,
  saved,
  onClose,
  onToggleSaved,
}: {
  story: Story;
  saved: boolean;
  onClose: () => void;
  onToggleSaved: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-layer">
      <button
        className="menu-scrim modal-scrim"
        type="button"
        onClick={onClose}
        aria-label="Close story"
      />
      <section
        className="story-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="story-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="modal-close" type="button" onClick={onClose} aria-label="Close story">
          <CloseIcon />
        </button>
        <p className="modal-kicker">{story.category}</p>
        <h2 id="story-modal-title">{story.title}</h2>
        <p>{story.detail}</p>
        <button className="modal-save" type="button" onClick={onToggleSaved}>
          <BookmarkIcon filled={saved} />
          {saved ? "Saved to My News" : "Save to My News"}
        </button>
      </section>
    </div>
  );
}

function SearchTray({
  query,
  onQueryChange,
  onClose,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  onClose: () => void;
}) {
  const onSubmit = (event: FormEvent<HTMLFormElement>) => event.preventDefault();

  return (
    <search className="search-tray">
      <form onSubmit={onSubmit}>
        <label htmlFor="site-search">Search stories</label>
        <div className="search-field">
          <SearchIcon />
          <input
            id="site-search"
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search stories"
          />
          {query && (
            <button type="button" className="clear-search" onClick={() => onQueryChange("")}>
              Clear
            </button>
          )}
          <button type="button" className="tray-close" onClick={onClose} aria-label="Close search">
            <CloseIcon />
          </button>
        </div>
      </form>
    </search>
  );
}

function MenuDrawer({
  category,
  savedCount,
  onCategoryChange,
  onClose,
}: {
  category: StoryCategory | "All stories";
  savedCount: number;
  onCategoryChange: (next: StoryCategory | "All stories") => void;
  onClose: () => void;
}) {
  return (
    <div className="menu-layer" role="presentation">
      <button className="menu-scrim" type="button" onClick={onClose} aria-label="Close menu" />
      <aside className="menu-drawer" aria-label="Site menu">
        <div className="drawer-head">
          <span>Sections</span>
          <button type="button" onClick={onClose} aria-label="Close menu">
            <CloseIcon />
          </button>
        </div>
        <nav>
          {categoryNames.map((name) => (
            <button
              key={name}
              type="button"
              className={category === name ? "active" : ""}
              onClick={() => {
                onCategoryChange(name);
                onClose();
              }}
            >
              {name}
            </button>
          ))}
        </nav>
        <p className="saved-count">
          {savedCount} {savedCount === 1 ? "story" : "stories"} saved
        </p>
      </aside>
    </div>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return <p className="empty-state">{children}</p>;
}

function App() {
  const [category, setCategory] = useState<StoryCategory | "All stories">("All stories");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [savedOnly, setSavedOnly] = useState(false);
  const [savedIds, setSavedIds] = useState<Set<string>>(() => new Set());
  const [selectedStory, setSelectedStory] = useState<Story | null>(null);

  const filteredStories = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return stories.filter((story) => {
      const categoryMatches = category === "All stories" || story.category === category;
      const savedMatches = !savedOnly || savedIds.has(story.id);
      const queryMatches =
        !normalizedQuery ||
        [story.title, story.excerpt, story.detail, story.category].some((value) =>
          value?.toLowerCase().includes(normalizedQuery),
        );
      return categoryMatches && savedMatches && queryMatches;
    });
  }, [category, query, savedIds, savedOnly]);

  const leadStory =
    !query.trim() && category === "All stories" && !savedOnly ? filteredStories[0] : undefined;
  const listStories = leadStory
    ? filteredStories.filter((story) => story.id !== leadStory.id)
    : filteredStories;

  const toggleSaved = (storyId: string) => {
    setSavedIds((current) => {
      const next = new Set(current);
      if (next.has(storyId)) {
        next.delete(storyId);
      } else {
        next.add(storyId);
      }
      return next;
    });
  };

  const openSearch = () => {
    setMenuOpen(false);
    setSearchOpen((open) => !open);
  };

  return (
    <div className="app-shell" id="top">
      <header className="site-header">
        <a
          className="brand"
          href="/Loylex/"
          onClick={() => {
            setCategory("All stories");
            setQuery("");
            setSavedOnly(false);
          }}
        >
          <ReutersMark />
          <span>Reuters</span>
        </a>
        <div className="header-actions">
          <button
            className={savedOnly ? "my-news-button active" : "my-news-button"}
            type="button"
            aria-pressed={savedOnly}
            onClick={() => {
              setSearchOpen(false);
              setSavedOnly((only) => !only);
            }}
          >
            My News
          </button>
          <button
            className="icon-button search-button"
            type="button"
            aria-label={searchOpen ? "Close search" : "Search"}
            aria-expanded={searchOpen}
            onClick={openSearch}
          >
            {searchOpen ? <CloseIcon /> : <SearchIcon />}
          </button>
          <button
            className="icon-button menu-button"
            type="button"
            aria-label="Open menu"
            aria-expanded={menuOpen}
            onClick={() => {
              setSearchOpen(false);
              setMenuOpen(true);
            }}
          >
            <MenuIcon />
          </button>
        </div>
      </header>

      {searchOpen && (
        <SearchTray query={query} onQueryChange={setQuery} onClose={() => setSearchOpen(false)} />
      )}
      {menuOpen && (
        <MenuDrawer
          category={category}
          savedCount={savedIds.size}
          onCategoryChange={setCategory}
          onClose={() => setMenuOpen(false)}
        />
      )}

      <main>
        {leadStory && (
          <>
            <section className="lead-story" aria-labelledby="lead-title">
              <button
                className="lead-button"
                type="button"
                onClick={() => setSelectedStory(leadStory)}
              >
                <h1 id="lead-title">{leadStory.title}</h1>
                <p className="lead-excerpt">{leadStory.excerpt}</p>
                <StoryMeta story={leadStory} />
              </button>
            </section>
            <div className="hero-visual">
              <ArchArtwork />
            </div>
          </>
        )}

        <section
          className={leadStory ? "news-list" : "news-list filtered-list"}
          aria-label="Latest stories"
        >
          {listStories.length > 0 ? (
            listStories.map((story) => (
              <article className="story-row" key={story.id}>
                <button
                  className="story-button"
                  type="button"
                  onClick={() => setSelectedStory(story)}
                >
                  <h2>{story.title}</h2>
                  <StoryMeta story={story} />
                </button>
                <button
                  className={savedIds.has(story.id) ? "save-control saved" : "save-control"}
                  type="button"
                  aria-label={savedIds.has(story.id) ? "Remove from My News" : "Save to My News"}
                  onClick={() => toggleSaved(story.id)}
                >
                  <BookmarkIcon filled={savedIds.has(story.id)} />
                </button>
              </article>
            ))
          ) : (
            <EmptyState>
              {savedOnly
                ? "Nothing saved yet. Open a story and add it to My News."
                : `No stories found${query ? ` for “${query}”` : ""}.`}
            </EmptyState>
          )}
        </section>
      </main>

      <footer className="site-footer">
        <p>The Terminal is a fictional technology desk. No reported event on this page is real.</p>
      </footer>

      {selectedStory && (
        <StoryModal
          story={selectedStory}
          saved={savedIds.has(selectedStory.id)}
          onClose={() => setSelectedStory(null)}
          onToggleSaved={() => toggleSaved(selectedStory.id)}
        />
      )}
    </div>
  );
}

export default App;
