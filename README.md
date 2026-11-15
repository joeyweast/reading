# Joey's Reading Room

A personal archive of books, ratings, and reading history. Live site: https://joeyweast.github.io/reading/

The library lives in a single data file, `data/library.json`. The site reads it when the page loads, and every count, chart, filter, and map is computed from it in the browser.

## What's on the site
- **Home:** the book I'm reading now, recent finishes, and collection totals (books, authors, pages, estimated listening hours).
- **Shelves:** every book, with search, filters by genre, subgenre, or shelf, and sorting. Each book shows its cover, series, rating, finish date, and review.
- **Statistics:** a reader profile, books finished per year, rating patterns, genres, publication eras, most-read authors, and a closer look inside the larger genres.
- **Universe:** an interactive map of the library. Books are linked by author, shared tags, subgenre, or genre, series appear as stacks, and each link type can be switched on or off.
- **Yearbook:** a month-by-month review of each year, with shareable graphics.
- **Settings:** comfort options such as reduced motion, saved on the device only.

## How it's organized
Each book has one main genre, two or three subgenres, and up to five tags, all drawn from a list kept inside the data file. Series are grouped as one entry. Changing a book's data updates everything that uses it.

## Notes
- Listening time is estimated from page counts.
- Some older books have no finish date, so they don't appear in year-by-year views.
- The site works on phones and desktops.
- Visits are counted anonymously with GoatCounter.
- Covers and descriptions belong to their publishers and authors.
