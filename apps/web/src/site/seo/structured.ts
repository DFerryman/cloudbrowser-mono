import { TIERS } from '@cloudbrowser/contracts';
import type { Article } from '../../content/types.js';
import { LEGAL_UPDATED, SECURITY_EMAIL, SUPPORT_EMAIL } from '../../lib/site.js';
import { canonicalUrl, message, SITE_NAME, SITE_URL, type PublicPage } from './pages.js';

/**
 * schema.org data for each prerendered page, as one JSON-LD graph: the organization and the
 * website on every page, the web application on the home and pricing pages, a TechArticle with
 * breadcrumbs on docs, and an FAQPage for the FAQ. Offers (live prices) are not known at build
 * time: the api Worker adds them to the application node (APP_ID) on each request.
 */

export const ORGANIZATION_ID = `${SITE_URL}/#organization`;
export const WEBSITE_ID = `${SITE_URL}/#website`;
export const APP_ID = `${SITE_URL}/#app`;

type Node = Record<string, unknown>;

const organization = (): Node => ({
  '@type': 'Organization',
  '@id': ORGANIZATION_ID,
  name: SITE_NAME,
  url: `${SITE_URL}/`,
  logo: { '@type': 'ImageObject', url: `${SITE_URL}/apple-touch-icon.png`, width: 180, height: 180 },
  email: SUPPORT_EMAIL,
  contactPoint: [
    { '@type': 'ContactPoint', contactType: 'customer support', email: SUPPORT_EMAIL, url: `${SITE_URL}/contact` },
    { '@type': 'ContactPoint', contactType: 'security', email: SECURITY_EMAIL, url: `${SITE_URL}/contact` },
  ],
});

const website = (): Node => ({
  '@type': 'WebSite',
  '@id': WEBSITE_ID,
  url: `${SITE_URL}/`,
  name: SITE_NAME,
  description: message('seo.home.description'),
  inLanguage: 'en',
  publisher: { '@id': ORGANIZATION_ID },
});

/** What Nevazu is, as a web application; the api Worker adds `offers` with live prices. */
export const application = (): Node => ({
  '@type': 'WebApplication',
  '@id': APP_ID,
  name: SITE_NAME,
  url: `${SITE_URL}/`,
  applicationCategory: 'BrowserApplication',
  operatingSystem: 'Web',
  browserRequirements: 'A current web browser with WebRTC and H.264 video (Chrome, Edge, Safari; Firefox with its OpenH264 plugin).',
  description: message('home.faq.1.a'),
  featureList: [
    message('home.p.cloud.title'),
    message('home.p.persist.title'),
    message('home.p.ip.title'),
    message('home.f.view.title'),
    message('home.f.agents.title'),
    message('home.f.sleep.title'),
    message('home.f.billing.title'),
    `${message('tier.basic')}: ${TIERS.basic.vcpu} vCPU, ${TIERS.basic.memoryGb} GB memory`,
    `${message('tier.premium')}: ${TIERS.premium.vcpu} vCPU, ${TIERS.premium.memoryGb} GB memory`,
  ],
  publisher: { '@id': ORGANIZATION_ID },
});

/** Questions and answers from an article whose headings are questions (the FAQ). */
export function faqEntities(article: Article): Node[] {
  const out: Node[] = [];
  for (const block of article.blocks) {
    if ('h' in block) out.push({ '@type': 'Question', name: block.h, acceptedAnswer: { '@type': 'Answer', text: '' } });
    else if ('p' in block && out.length) {
      const answer = (out.at(-1)!.acceptedAnswer as { text: string });
      answer.text = answer.text ? `${answer.text} ${block.p}` : block.p;
    }
  }
  return out.filter((q) => (q.acceptedAnswer as { text: string }).text);
}

function breadcrumbs(page: PublicPage): Node | null {
  if (page.kind === 'home') return null;
  const trail: [string, string][] = [[SITE_NAME, `${SITE_URL}/`]];
  if (page.kind === 'doc') trail.push([message('docs.title'), `${SITE_URL}/docs`]);
  trail.push([page.article?.title ?? page.title.split(' | ')[0]!, canonicalUrl(page)]);
  return {
    '@type': 'BreadcrumbList',
    '@id': `${canonicalUrl(page)}#breadcrumb`,
    itemListElement: trail.map(([name, item], i) => ({ '@type': 'ListItem', position: i + 1, name, item })),
  };
}

/** The page's JSON-LD graph. `modified` is when the docs content last changed (ISO), where known. */
export function structuredData(page: PublicPage, { modified }: { modified?: string } = {}): Node {
  const url = canonicalUrl(page);
  const crumbs = breadcrumbs(page);
  const isFaq = page.kind === 'doc' && page.article?.slug === 'faq';
  const dateModified = page.kind === 'policy' ? LEGAL_UPDATED : page.kind === 'doc' || page.kind === 'docs' ? modified : undefined;
  const webPage: Node = {
    '@type': isFaq ? 'FAQPage' : page.kind === 'docs' ? 'CollectionPage' : page.kind === 'contact' ? 'ContactPage' : 'WebPage',
    '@id': `${url}#webpage`,
    url,
    name: page.title,
    description: page.description,
    inLanguage: 'en',
    isPartOf: { '@id': WEBSITE_ID },
    publisher: { '@id': ORGANIZATION_ID },
    ...(dateModified ? { dateModified } : {}),
    ...(crumbs ? { breadcrumb: { '@id': crumbs['@id'] } } : {}),
    ...(page.kind === 'home' || page.kind === 'pricing' ? { about: { '@id': APP_ID } } : {}),
    ...(isFaq && page.article ? { mainEntity: faqEntities(page.article) } : {}),
  };
  const graph: Node[] = [organization(), website(), webPage];
  if (page.kind === 'home' || page.kind === 'pricing') graph.push(application());
  if (page.kind === 'doc' && page.article && !isFaq) {
    graph.push({
      '@type': 'TechArticle',
      '@id': `${url}#article`,
      headline: page.article.title,
      description: page.article.summary,
      url,
      inLanguage: 'en',
      mainEntityOfPage: { '@id': `${url}#webpage` },
      author: { '@id': ORGANIZATION_ID },
      publisher: { '@id': ORGANIZATION_ID },
      ...(dateModified ? { dateModified } : {}),
    });
  }
  if (crumbs) graph.push(crumbs);
  return { '@context': 'https://schema.org', '@graph': graph };
}

/**
 * JSON for a <script type="application/ld+json"> element: `<` is escaped so no text in it can
 * close the element. (A JSON-LD block is data, not script: the CSP's script-src does not apply.)
 */
export const jsonLdScript = (data: unknown) => JSON.stringify(data).replace(/</g, '\\u003c');
