// Classifier regression tests: node test/classify.test.mjs
import assert from 'node:assert/strict';
import { regionOf, categoriesOf, isInternTitle, isClearlyNonTech, seasonOf, seasonOk } from '../radar/lib/classify.mjs';

const regions = {
  'Bratislavský kraj, 821 04': 'intl', 'Heredia, Heredia, 400803': 'intl', 'Cork, CO, IE': 'intl', 'SGP - Woodlands': 'intl',
  'St-Laurent, QC, CAN': 'ca', 'Wuxi, CHN': 'intl', 'SAN SEBASTIAN DE LOS REYES, M, ES': 'intl', 'Tijuana, B.C., MX': 'intl',
  'Auckland, NZ': 'intl', '379 Interpace Pkwy, Parsippany, 07054': 'us', 'PA-CLIENT-STATE': 'us', 'Work Remotely': 'remote',
  'Galway, Galway, H91 WP08': 'intl', 'Peru': 'intl', 'Casablanca, Morocco': 'intl', 'Denver, CO': 'us', 'Indianapolis, IN': 'us',
  'Wilmington, DE': 'us', 'San Francisco, CA': 'us', 'Toronto, ON': 'ca', 'Chicago, Illinois, United States of America': 'us',
  'Remote - US': 'us', 'London, UK': 'intl', 'Bengaluru, India': 'intl', 'New York, NY 10001': 'us', 'Atlanta, GA': 'us',
  'Cambridge, MA': 'us', 'Remote': 'remote', 'US-OK-CLAREMORE-200 W STUART ROOSA DR': 'us', 'WI Madison': 'us', 'NYC': 'us',
};
for (const [l, want] of Object.entries(regions)) assert.equal(regionOf(l), want, `regionOf(${l})`);

const cats = {
  'Software Engineer Intern': 'swe', 'Student Researcher, BS/MS, Winter-Summer 2027': 'ai', 'Research Sciences INTERN': 'ai',
  'Machine Learning Intern': 'ai', 'Infra Intern': 'swe', 'Autopilot Intern': 'ai', 'Quantitative Trader Intern': 'quant',
  'FPGA Design Intern': 'hw', 'Product Manager Intern': 'pm', 'Applied Data Solutions Program, Internships – Summer 2027': 'data',
};
for (const [t, want] of Object.entries(cats)) assert.ok(categoriesOf(t).includes(want), `categoriesOf(${t}) has ${want}: ${categoriesOf(t)}`);

for (const t of ['Marketing Intern', 'Finance Intern', 'Mechanical Engineering Intern', 'HR Intern', 'Business Development Intern']) assert.ok(isClearlyNonTech(t), t);
for (const t of ['Autopilot Intern', 'Software Engineer Intern', 'Starship Intern', 'Data Center Technicians Intern']) assert.ok(!isClearlyNonTech(t), t);
for (const t of ['Software Engineer Intern', 'Co-op, Firmware', 'Summer Analyst - Technology', 'Werkstudent Software']) assert.ok(isInternTitle(t), t);
for (const t of ['Senior Software Engineer', 'University Recruiter, Interns', 'Internal Tools Engineer', 'International Sales Manager']) assert.ok(!isInternTitle(t), t);
assert.equal(seasonOf('Software Engineer Intern (Summer 2027)'), 'Summer 2027');
assert.ok(seasonOk('Summer 2027') && seasonOk('Winter 2027') && seasonOk('2026') && seasonOk(''));
assert.ok(!seasonOk('Summer 2026') && !seasonOk('Fall 2026'));
console.log(`classify tests passed (${Object.keys(regions).length} locations, ${Object.keys(cats).length} categories)`);
