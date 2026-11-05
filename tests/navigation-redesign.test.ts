import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const htmlPath = path.resolve('DoseBuddy_frontend', 'index.html');
const cssPath = path.resolve('DoseBuddy_frontend', 'style.css');
const responsivePath = path.resolve('DoseBuddy_frontend', 'responsive.css');
const jsPath = path.resolve('DoseBuddy_frontend', 'app.js');

test('Navigation redesign - HTML structure and elements', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');

  // Full-width topnav structure
  assert.ok(html.includes('class="topnav"'), 'topnav element exists');
  assert.ok(html.includes('class="topnav-main"'), 'topnav-main container exists');
  assert.ok(html.includes('id="desktop-nav"'), 'desktop horizontal navigation row exists');
  assert.ok(html.includes('class="desktop-nav-bar"'), 'desktop-nav-bar class exists');

  // Verify all 7 views in desktop nav
  const expectedDesktopViews = [
    'dashboard-view',
    'add-medicine-view',
    'reports-view',
    'history-view',
    'bmi-view',
    'vitals-view',
    'ai-view'
  ];
  for (const viewId of expectedDesktopViews) {
    assert.ok(
      html.includes(`data-view="${viewId}"`),
      `desktop nav or drawer contains data-view="${viewId}"`
    );
  }

  // Verify desktop More dropdown
  assert.ok(html.includes('id="desktop-nav-more"'), 'desktop more container exists');
  assert.ok(html.includes('id="desktop-nav-more-btn"'), 'desktop more toggle button exists');
  assert.ok(html.includes('id="desktop-nav-more-menu"'), 'desktop more dropdown menu exists');

  // Verify drawer elements
  assert.ok(html.includes('id="drawer-close-btn"'), 'drawer close button exists');
  assert.ok(html.includes('id="menu-overlay"'), 'drawer backdrop overlay exists');
  assert.ok(html.includes('id="user-menu"'), 'drawer sidebar exists with id user-menu');

  // Verify profile dropdown dark mode toggle
  assert.ok(html.includes('id="pd-theme-toggle"'), 'profile dropdown theme toggle exists');
});

test('Navigation redesign - CSS full-width architecture and tokens', () => {
  const css = fs.readFileSync(cssPath, 'utf8');

  // Full-width app-shell (flex column, no fixed sidebar grid)
  assert.match(css, /\.app-shell\s*\{[^}]*display:\s*flex;/i, 'app-shell uses flex layout');
  assert.match(css, /\.app-shell\s*\{[^}]*flex-direction:\s*column;/i, 'app-shell is flex column');

  // Full-width topnav
  assert.match(css, /\.topnav\s*\{[^}]*width:\s*100%;/i, 'topnav is 100% full-width');
  assert.match(css, /\.topnav\s*\{[^}]*position:\s*sticky;/i, 'topnav is sticky');

  // Desktop nav bar styling
  assert.ok(css.includes('.desktop-nav-bar'), '.desktop-nav-bar styling exists');
  assert.ok(css.includes('.desktop-nav-link'), '.desktop-nav-link styling exists');
  assert.ok(css.includes('.desktop-nav-link.active'), '.desktop-nav-link active styling exists');
  assert.ok(css.includes('.desktop-nav-more-menu'), '.desktop-nav-more-menu styling exists');

  // Drawer styles and scroll-locking
  assert.ok(css.includes('.sidebar'), '.sidebar styling exists');
  assert.ok(css.includes('.sidebar.open'), '.sidebar.open styling exists');
  assert.ok(css.includes('.drawer-close-btn'), '.drawer-close-btn styling exists');
  assert.ok(css.includes('body.drawer-open'), 'body.drawer-open overflow lock exists');
  assert.match(css, /body\.drawer-open\s*\{[^}]*overflow:\s*hidden/i, 'body.drawer-open locks overflow');

  // Main content max-width container
  assert.match(css, /\.main-content\s*\{[^}]*max-width:\s*1440px/i, 'main-content is centered with 1440px max width');
});

test('Navigation redesign - Responsive breakpoints', () => {
  const responsive = fs.readFileSync(responsivePath, 'utf8');

  // Desktop breakpoint (>= 1024px)
  assert.match(responsive, /@media\s*\(\s*min-width:\s*1024px\s*\)/, '1024px desktop breakpoint exists');
  assert.ok(responsive.includes('.desktop-nav-bar'), 'desktop nav bar configured in responsive css');

  // Intermediate tablet / small desktop collapsible items (1024px - 1180px)
  assert.ok(
    responsive.includes('.desktop-nav-collapsible') && responsive.includes('.desktop-nav-more'),
    'collapsible nav items and more dropdown configured for intermediate widths'
  );

  // Mobile / tablet drawer (< 1024px)
  assert.match(responsive, /@media\s*\(\s*max-width:\s*1023px\s*\)/, 'max-width: 1023px drawer breakpoint exists');
});

test('Navigation redesign - JavaScript controller integration', () => {
  const js = fs.readFileSync(jsPath, 'utf8');

  // Desktop more nav controller
  assert.ok(js.includes('setupDesktopMoreNav'), 'setupDesktopMoreNav function defined');
  assert.ok(js.includes('desktop-nav-more-btn'), 'desktop more button handled');
  assert.ok(js.includes('desktop-nav-more-menu'), 'desktop more menu handled');

  // Drawer handling
  assert.ok(js.includes('drawer-close-btn'), 'drawer close button handled');
  assert.ok(js.includes('drawer-open'), 'body drawer-open class toggled');

  // Active navigation state sync across desktop and mobile
  assert.ok(js.includes('.nav-btn[data-view]'), 'navigation buttons synchronized');
  assert.ok(js.includes('activeInMore'), 'desktop more button active state evaluated');
});
