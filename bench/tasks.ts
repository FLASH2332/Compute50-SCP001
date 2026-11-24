/**
 * The benchmark tasks: 9 categories x 2 tasks over 7 sites. Each task has an automatic check (check.ts).
 * `quick: true` marks the 9-task subset (one per category) that `npm run bench:run -- --quick` runs.
 *
 * Tasks are about the real site, not about either graph: a variant passes when its graph lets the same agent find
 * and act on the right thing. URLs in checks are regexes on the browser's final URL.
 */

export type Category =
  | 'nav'          // open a page that a link names
  | 'list-item'    // pick one item out of a repeated list (cards, rows)
  | 'deep'         // a page two or more steps away: needs a route
  | 'pagination'   // a later page of a list
  | 'click'        // press a button / control that does something on the page
  | 'form'         // type into or choose in a field
  | 'fact'         // answer a question about the app from the graph
  | 'unseen'       // a page the crawler may only know by a link, or not at all
  | 'impossible';  // not on the site: the agent must say NOT FOUND

export const CATEGORIES: Category[] = ['nav', 'list-item', 'deep', 'pagination', 'click', 'form', 'fact', 'unseen', 'impossible'];

export interface Check {
  url?: string;          // regex the final browser URL must match
  answer?: string[];     // regexes the final answer must all match (case-insensitive)
  notFound?: boolean;    // the answer must say NOT FOUND
  performed?: string;    // regex on the label of an action that `perform` or `fill` completed (done: true)
  filled?: string;       // regex on the text of a completed `fill`
}

export interface Task {
  id: string;
  site: string;
  category: Category;
  task: string;
  check: Check;
  quick?: boolean;
  why: string;           // what the task probes in the graph
}

export const TASKS: Task[] = [
  // nav
  { id: 'quotes-login', site: 'quotes', category: 'nav', quick: true,
    task: 'Open the login page.',
    check: { url: '/login/?$' },
    why: 'A header link: both graphs have it; checks the basics work' },
  { id: 'pst-contact', site: 'pst', category: 'nav',
    task: 'Open the Contact page.',
    check: { url: '/contact' },
    why: 'A link in a JS-rendered (Angular) header' },

  // list-item
  { id: 'books-study-in-scarlet', site: 'books', category: 'list-item', quick: true,
    task: "In the Mystery category, open the book 'A Study in Scarlet (Sherlock Holmes #1)'.",
    check: { url: '/a-study-in-scarlet-sherlock-holmes-1_656/' },
    why: 'The 10th card of a 20-card list: grouped repeats keep only 3 examples; a list template keeps every item' },
  { id: 'demoblaze-nexus', site: 'demoblaze', category: 'list-item',
    task: "Open the product page of the phone 'Nexus 6'.",
    check: { url: 'prod\\.html\\?idp_=3' },
    why: 'A card in a list rendered by JavaScript after load' },

  // deep
  { id: 'fixture-orders', site: 'fixture', category: 'deep', quick: true,
    task: "Open the 'My orders' page of the shop.",
    check: { url: '/orders\\.html' },
    why: 'Behind an Account menu button (or a hover submenu), two steps from the start page' },
  { id: 'books-fantasy-p2', site: 'books', category: 'deep',
    task: 'Open the second page of the Fantasy category.',
    check: { url: '/fantasy_19/page-2\\.html' },
    why: 'Category, then its Next link: a route through a page the crawler may not have opened' },

  // pagination
  { id: 'quotes-page-3', site: 'quotes', category: 'pagination', quick: true,
    task: 'Go to page 3 of the quotes list.',
    check: { url: '/page/3/?$' },
    why: 'Following Next twice' },
  { id: 'demoblaze-next', site: 'demoblaze', category: 'pagination',
    task: 'On the home page, show the next page of products.',
    check: { performed: '^next' },
    why: 'A Next button that changes the list without changing the URL' },

  // click
  { id: 'testsite-new-invoice', site: 'testsite', category: 'click', quick: true,
    task: 'Open the form for creating a new invoice.',
    check: { performed: 'create invoice|new invoice' },
    why: 'A button whose effect (opens a dialog) was recorded by click probing' },
  { id: 'internet-add-element', site: 'internet', category: 'click',
    task: 'On the Add/Remove Elements page, add an element.',
    check: { performed: 'add element', url: '/add_remove_elements' },
    why: 'A plain button on a page one hop from the start' },

  // form
  { id: 'fixture-search-lamp', site: 'fixture', category: 'form', quick: true,
    task: "Search the shop for 'lamp'.",
    check: { url: 'results\\.html\\?(.*&)?q=lamp' },
    why: 'A GET search form: fill and submit' },
  { id: 'internet-dropdown', site: 'internet', category: 'form',
    task: "On the Dropdown page, choose 'Option 2'.",
    check: { filled: 'option 2', url: '/dropdown' },
    why: 'A select field' },

  // fact
  { id: 'fixture-finder-fields', site: 'fixture', category: 'fact', quick: true,
    task: "Which fields can you fill in on the 'Book finder' form? List them.",
    check: { answer: ['search books', 'category', 'max price', 'format|paperback'] },
    why: 'Fields of one form, from the graph only' },
  { id: 'testsite-toggle-filters', site: 'testsite', category: 'fact',
    task: "What happens when you click the 'Toggle Filters' button? Answer without clicking it.",
    check: { answer: ['expand|panel|show|reveal|open'] },
    why: 'A recorded click result (interaction)' },

  // unseen
  { id: 'internet-tables', site: 'internet', category: 'unseen', quick: true,
    task: "Open the 'Sortable Data Tables' example page.",
    check: { url: '/tables' },
    why: 'Far down a 70-link list: known by link, probably not opened within the page budget' },
  { id: 'quotes-neruda', site: 'quotes', category: 'unseen',
    task: "Open the author page of Pablo Neruda.",
    check: { url: '/author/Pablo-Neruda' },
    why: 'Only linked from page 3 of the quotes: depends on what the crawl reached' },

  // impossible
  { id: 'books-checkout', site: 'books', category: 'impossible', quick: true,
    task: 'Open the checkout page and pay for the basket.',
    check: { notFound: true },
    why: 'The site has no basket or checkout: the agent must not invent one' },
  { id: 'quotes-cart', site: 'quotes', category: 'impossible',
    task: 'Open the shopping cart.',
    check: { notFound: true },
    why: 'No cart on a quotes site' },
];
