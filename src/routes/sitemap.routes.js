const router = require('express').Router();
const { pool } = require('../config/database');

router.get('/', async (req, res, next) => {
  try {
    const baseUrl = process.env.FRONTEND_URL || 'https://www.swiftroute.in';
    const [routes] = await pool.query('SELECT slug, updated_at FROM routes WHERE is_active = 1 AND deleted_at IS NULL');
    const [packages] = await pool.query('SELECT slug, updated_at FROM packages WHERE is_active = 1 AND deleted_at IS NULL');
    const [blogs] = await pool.query('SELECT slug, updated_at FROM blogs WHERE status = "published"');
    const [locations] = await pool.query('SELECT slug, updated_at FROM locations WHERE is_active = 1');

    const staticPages = ['', '/routes', '/packages', '/offers', '/about', '/contact', '/gallery', '/blog'];

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;

    staticPages.forEach(p => {
      xml += `\n  <url><loc>${baseUrl}${p}</loc><changefreq>weekly</changefreq><priority>${p === '' ? '1.0' : '0.8'}</priority></url>`;
    });
    routes.forEach(r => {
      xml += `\n  <url><loc>${baseUrl}/routes/${r.slug}</loc><lastmod>${new Date(r.updated_at).toISOString().split('T')[0]}</lastmod><changefreq>weekly</changefreq><priority>0.9</priority></url>`;
    });
    packages.forEach(p => {
      xml += `\n  <url><loc>${baseUrl}/packages/${p.slug}</loc><lastmod>${new Date(p.updated_at).toISOString().split('T')[0]}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`;
    });
    blogs.forEach(b => {
      xml += `\n  <url><loc>${baseUrl}/blog/${b.slug}</loc><lastmod>${new Date(b.updated_at).toISOString().split('T')[0]}</lastmod><changefreq>monthly</changefreq><priority>0.6</priority></url>`;
    });
    locations.forEach(l => {
      xml += `\n  <url><loc>${baseUrl}/travel/${l.slug}</loc><changefreq>monthly</changefreq><priority>0.5</priority></url>`;
    });

    xml += '\n</urlset>';
    res.set('Content-Type', 'application/xml');
    res.send(xml);
  } catch(err) { next(err); }
});

module.exports = router;
