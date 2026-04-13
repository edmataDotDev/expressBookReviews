'use strict';

/**
 * Strict endpoint checks: failing status codes, HTML error pages, and hangs
 * are reported with the real HTTP status and a body preview (t.diagnostic).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../index.js');

const REQUEST_TIMEOUT_MS = 8000;

/** Short preview for diagnostics (one line). */
function bodyPreview(res) {
  if (res.text && res.text.length) {
    return res.text.slice(0, 350).replace(/\s+/g, ' ').trim();
  }
  try {
    return JSON.stringify(res.body).slice(0, 350);
  } catch {
    return '(no body)';
  }
}

function logResult(t, name, res) {
  t.diagnostic(`${name} → ${res.status} | ${bodyPreview(res)}`);
}

function assertStatus(t, name, res, expected) {
  logResult(t, name, res);
  if (res.status >= 500) {
    assert.fail(
      `${name}: server error ${res.status} (handler threw or misconfigured). See diagnostic line above.`
    );
  }
  if (res.status !== expected) {
    assert.fail(
      `${name}: expected HTTP ${expected}, got ${res.status}. See diagnostic line above for body.`
    );
  }
}

test('GET / — list books (JSON payload, now 200)', async (t) => {
  const res = await request(app).get('/').timeout(REQUEST_TIMEOUT_MS);
  assertStatus(t, 'GET /', res, 200);
  const raw = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
  assert.ok(
    raw.includes('Chinua Achebe') || raw.includes('Things Fall Apart'),
    `GET /: expected book data in body, got: ${bodyPreview(res)}`
  );
});

test('GET /isbn/1 — single book', async (t) => {
  const res = await request(app).get('/isbn/1').timeout(REQUEST_TIMEOUT_MS);
  assertStatus(t, 'GET /isbn/1', res, 200);
  const raw = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
  assert.ok(raw.includes('Chinua'), `GET /isbn/1: expected author in body, got: ${bodyPreview(res)}`);
});

test('GET /author/Chinua Achebe', async (t) => {
  const res = await request(app)
    .get('/author/Chinua%20Achebe')
    .timeout(REQUEST_TIMEOUT_MS);
  assertStatus(t, 'GET /author', res, 200);
  const raw = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
  assert.ok(
    raw.includes('Chinua') || raw.includes('Achebe'),
    `GET /author: expected author in body, got: ${bodyPreview(res)}`
  );
});

test('GET /title/Things Fall Apart', async (t) => {
  const res = await request(app)
    .get('/title/Things%20Fall%20Apart')
    .timeout(REQUEST_TIMEOUT_MS);
  assertStatus(t, 'GET /title', res, 200);
  const raw = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
  assert.ok(
    raw.includes('Things Fall Apart') || raw.includes('Chinua'),
    `GET /title: expected title in body, got: ${bodyPreview(res)}`
  );
});

test('GET /review/1 — reviews object', async (t) => {
  const res = await request(app).get('/review/1').timeout(REQUEST_TIMEOUT_MS);
  assertStatus(t, 'GET /review/1', res, 200);
});

test('POST /register — register user (201)', async (t) => {
  const res = await request(app)
    .post('/register')
    .send({ username: 'x', password: 'y' })
    .timeout(REQUEST_TIMEOUT_MS);
  assertStatus(t, 'POST /register', res, 201);
});

test('POST /register body — 201 + message', async (t) => {
  const u = `u_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const res = await request(app)
    .post('/register')
    .send({ username: u, password: 'pw12345' })
    .timeout(REQUEST_TIMEOUT_MS);
  assertStatus(t, 'POST /register', res, 201);
  assert.ok(
    res.body && (res.body.message === 'Account created' || res.body.message === 'User successfully registered. Now you can login.'),
    `POST /register: expected a successful registration message, got: ${bodyPreview(res)}`
  );
});

test('POST /customer/login — 200 + JSON body (must finish response)', async (t) => {
  const u = `login_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  await request(app)
    .post('/register')
    .send({ username: u, password: 'pw12345' })
    .timeout(REQUEST_TIMEOUT_MS);
  const res = await request(app)
    .post('/customer/login')
    .send({ username: u, password: 'pw12345' })
    .timeout(REQUEST_TIMEOUT_MS);
  assertStatus(t, 'POST /customer/login', res, 200);
  assert.ok(
    res.body && res.body.message === 'Login successful',
    `POST /customer/login: expected { message: 'Login successful' }, got: ${bodyPreview(res)}`
  );
});

test('PUT + DELETE /customer/auth/review/1 — session + JWT (same agent)', async (t) => {
  const u = `rev_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const agent = request.agent(app);

  const reg = await agent
    .post('/register')
    .send({ username: u, password: 'pw12345' })
    .timeout(REQUEST_TIMEOUT_MS);
  logResult(t, 'register (agent)', reg);
  assert.equal(reg.status, 201, `register failed: ${bodyPreview(reg)}`);

  const log = await agent
    .post('/customer/login')
    .send({ username: u, password: 'pw12345' })
    .timeout(REQUEST_TIMEOUT_MS);
  logResult(t, 'login (agent)', log);
  assert.equal(log.status, 200, `login failed: ${bodyPreview(log)}`);

  let putRes;
  try {
    putRes = await agent
      .put('/customer/auth/review/1')
      .query({ review: 'integration test review' })
      .send({})
      .timeout(REQUEST_TIMEOUT_MS);
  } catch (err) {
    assert.fail(
      `PUT review: request did not complete (${err.message}). ` +
        'Often: auth middleware never calls next(), or jwt.verify secret mismatch (sign vs middleware).'
    );
  }
  logResult(t, 'PUT /customer/auth/review/1', putRes);
  if (putRes.status === 401) {
    assert.fail(
      'PUT review: 401 Unauthorized. Typical causes: (1) jwt.verify in index.js must use the same secret as jwt.sign in login ' +
        '(e.g. both "privateKey"); (2) set req.token = req.session.jwt in middleware before next(). Body: ' +
        bodyPreview(putRes)
    );
  }
  if (putRes.status >= 500) {
    assert.fail(
      `PUT review: server error ${putRes.status}. Check route handler (e.g. undefined variable in jwt.verify). ${bodyPreview(putRes)}`
    );
  }
  assert.equal(putRes.status, 200, `PUT review: expected 200, got ${putRes.status}`);
  assert.ok(
    putRes.body &&
      putRes.body.message === 'Review for ISBN 1 added or updated' &&
      typeof putRes.body.reviews === 'object',
    `PUT review: expected updated review payload, got: ${bodyPreview(putRes)}`
  );

  let delRes;
  try {
    delRes = await agent
      .delete('/customer/auth/review/1')
      .timeout(REQUEST_TIMEOUT_MS);
  } catch (err) {
    assert.fail(`DELETE review: request did not complete (${err.message}).`);
  }
  logResult(t, 'DELETE /customer/auth/review/1', delRes);
  if (delRes.status >= 500) {
    assert.fail(`DELETE review: server error ${delRes.status}. ${bodyPreview(delRes)}`);
  }
  assert.equal(delRes.status, 200, `DELETE review: expected 200, got ${delRes.status}`);
  assert.ok(
    delRes.body && delRes.body.message === 'Review for ISBN 1 deleted',
    `DELETE review: expected delete confirmation message, got: ${bodyPreview(delRes)}`
  );
});
