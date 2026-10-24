import { TERMS_VERSION, termsDocumentPath } from '@cloudbrowser/contracts';
import { ToastProvider } from '@cloudbrowser/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToString } from 'react-dom/server';
import { StaticRouter, useRoutes, type RouteObject } from 'react-router';
import { termsDocument } from '../content/terms-document.js';
import { I18nProvider } from '../lib/i18n.js';
import { ThemeProvider } from '../lib/theme.js';
import { ContactPage } from '../site/ContactPage.js';
import { DocsPage } from '../site/DocsPage.js';
import { HomePage } from '../site/HomePage.js';
import { LegalPage } from '../site/LegalPage.js';
import { PricingPage } from '../site/PricingPage.js';
import { PublicShell } from '../site/PublicShell.js';
import { StatusPage } from '../site/StatusPage.js';
import { fillTemplate, headTags } from '../site/seo/html.js';
import { publicPages } from '../site/seo/pages.js';
import { structuredData } from '../site/seo/structured.js';
import { llmsFullTxt, llmsTxt, pageMarkdown, robotsTxt, sitemapXml } from '../site/seo/text.js';

/**
 * Build-time prerendering of the public site (scripts/prerender.mjs runs it after `vite build`):
 * the real page components, rendered to HTML in English with no network, so that crawlers which
 * do not run JavaScript see each page's text. Data the pages load (prices, status, whether the
 * visitor is signed in) stays pending, as on a first paint; the api Worker adds live prices.
 */

/** The public routes of src/router.tsx, without lazy loading: everything renders in one pass. */
const routes: RouteObject[] = [
  {
    element: <PublicShell />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/pricing', element: <PricingPage /> },
      { path: '/docs', element: <DocsPage /> },
      { path: '/docs/:slug', element: <DocsPage /> },
      { path: '/status', element: <StatusPage /> },
      { path: '/terms', element: <LegalPage policy="terms" /> },
      { path: '/privacy', element: <LegalPage policy="privacy" /> },
      { path: '/refunds', element: <LegalPage policy="refunds" /> },
      { path: '/contact', element: <ContactPage /> },
    ],
  },
];

function Routes() {
  return useRoutes(routes);
}

export function renderPage(path: string): string {
  // Queries never run: nothing is fetched while prerendering.
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  return renderToString(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <I18nProvider locale="en">
          <ToastProvider>
            <StaticRouter location={path}>
              <Routes />
            </StaticRouter>
          </ToastProvider>
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

/**
 * Every file the prerender adds to dist/, by path: an HTML page and a markdown twin per public
 * page, robots.txt, sitemap.xml, llms.txt and llms-full.txt. `template` is the built
 * dist/index.html; `builtAt` dates the sitemap; `modified` is when the docs content last changed.
 */
export function siteFiles({ template, builtAt, modified }: { template: string; builtAt: string; modified?: string }): Map<string, string> {
  const pages = publicPages();
  const files = new Map<string, string>();
  for (const page of pages) {
    const body = renderPage(page.path);
    // The Terms intentionally start with their update date and summary, without a page title.
    const hasContent = page.path === '/terms' ? body.includes('<article') : body.includes('<h1');
    if (!hasContent) throw new Error(`prerender: ${page.path} rendered no page content`);
    files.set(page.file, fillTemplate(template, headTags(page, structuredData(page, { modified })), body));
    const markdown = pageMarkdown(page);
    if (page.markdown && markdown) files.set(page.markdown.slice(1), markdown);
  }
  files.set('robots.txt', robotsTxt());
  files.set('sitemap.xml', sitemapXml(pages, builtAt));
  files.set('llms.txt', llmsTxt());
  files.set('llms-full.txt', llmsFullTxt());
  files.set(termsDocumentPath(TERMS_VERSION).slice(1), termsDocument());
  return files;
}
