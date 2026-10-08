// migration/app.js
// External script — avoids CSP inline-script restrictions
// Developed by Keyn Labs

(function() {
    'use strict';

    // ============================================================
    // CONFIG
    // ============================================================
    var SUPABASE_URL = 'https://zvhuromubukylsxrsfiz.supabase.co';
    var SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp2aHVyb211YnVreWxzeHJzZml6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgwODI4MDYsImV4cCI6MjEwMzY1ODgwNn0.29J2uGHxFhPtEqRZvnXjaYpL-x4I0uEc2TT8u9d5PVw';

    var HEADERS = {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
    };

    // Category expansions
    var CATEGORY_EXPANSIONS = {
        'retinol': ['retinol', 'serum', 'face serum', 'skin serum', 'skin care', 'skincare', 'anti aging', 'anti-aging', 'wrinkle', 'essence'],
        'sunscreen': ['sunscreen', 'spf', 'spf 50', 'spf 30', 'sun protection', 'sunblock', 'sun care', 'uv protection', 'sun lotion'],
        'serum': ['serum', 'face serum', 'skin serum', 'essence', 'ampoule', 'concentrate'],
        'cream': ['cream', 'face cream', 'moisturizer', 'moisturiser', 'lotion', 'skin cream'],
        'gel': ['gel', 'face gel', 'skin gel', 'aloe gel'],
        'skincare': ['skin care', 'skincare', 'cosmetic', 'beauty', 'derma', 'skin'],
        'lotion': ['lotion', 'body lotion', 'face lotion', 'moisturizer', 'moisturiser'],
        'gloves': ['gloves', 'hand gloves', 'safety gloves', 'industrial gloves', 'ppe', 'work gloves', 'nitrile gloves'],
        'ppe': ['ppe', 'personal protective equipment', 'safety gear', 'protective gear', 'safety equipment'],
        'mask': ['mask', 'face mask', 'surgical mask', 'n95', 'protective mask'],
        'sanitizer': ['sanitizer', 'hand sanitizer', 'sanitiser', 'disinfectant'],
        'vitamin c': ['vitamin c', 'ascorbic acid', 'vit c'],
        'spf': ['spf', 'spf 50', 'spf 30', 'spf 40', 'spf50', 'sun protection factor']
    };

    // ============================================================
    // LOGGING HELPERS
    // ============================================================
    function log(step, message, type) {
        type = type || 'info';
        var logEl = document.getElementById(step + '-log');
        if (!logEl) return;
        logEl.classList.add('show');
        var line = document.createElement('div');
        line.className = 'log-line ' + type;
        var time = new Date().toISOString().substring(11, 19);
        line.textContent = '[' + time + '] ' + message;
        logEl.appendChild(line);
        logEl.scrollTop = logEl.scrollHeight;
    }

    function showResult(step, message, isOk) {
        var el = document.getElementById(step + '-result');
        if (!el) return;
        el.classList.add('show');
        el.classList.toggle('ok', isOk === true);
        el.classList.toggle('err', isOk === false);
        el.textContent = message;
    }

    function setStatus(step, status) {
        var el = document.getElementById(step + '-status');
        if (el) el.textContent = status;
        var stepEl = document.getElementById(step);
        if (!stepEl) return;
        stepEl.classList.remove('done', 'error', 'running');
        if (status === 'DONE' || status === 'OK') stepEl.classList.add('done');
        else if (status === 'ERROR' || status === 'FAILED') stepEl.classList.add('error');
        else if (status === 'RUNNING') stepEl.classList.add('running');
    }

    function setBtnDisabled(step, disabled) {
        var btn = document.getElementById(step + '-btn');
        if (btn) btn.disabled = disabled;
    }

    // ============================================================
    // STEP 1: TEST CONNECTION
    // ============================================================
    async function runStep1() {
        setBtnDisabled('step1', true);
        setStatus('step1', 'RUNNING');
        document.getElementById('step1-log').innerHTML = '';

        try {
            log('step1', 'Testing connection to Supabase...');
            log('step1', 'GET ' + SUPABASE_URL + '/rest/v1/filters?select=id,filter_name,filter_config');

            var res = await fetch(SUPABASE_URL + '/rest/v1/filters?select=id,filter_name,filter_config', {
                headers: HEADERS
            });

            log('step1', 'Response status: ' + res.status, res.ok ? 'ok' : 'err');

            if (!res.ok) {
                var text = await res.text();
                throw new Error('HTTP ' + res.status + ': ' + text.substring(0, 300));
            }

            var filters = await res.json();
            log('step1', 'Found ' + filters.length + ' filter(s)', 'ok');

            if (filters.length > 0) {
                filters.forEach(function(f, i) {
                    log('step1', '  Filter #' + (i + 1) + ': id=' + f.id + ', name="' + (f.filter_name || 'unnamed') + '"', 'data');
                    log('step1', '    has filter_config: ' + (f.filter_config ? 'yes' : 'no'), 'data');
                    if (f.filter_config && f.filter_config.product_names) {
                        log('step1', '    product_names: ' + JSON.stringify(f.filter_config.product_names), 'data');
                    }
                });
            }

            setStatus('step1', 'OK');
            showResult('step1', '✅ Connection successful\n\nFound ' + filters.length + ' filter(s) in your database.', true);
        } catch (err) {
            log('step1', 'Connection failed: ' + err.message, 'err');
            setStatus('step1', 'FAILED');
            showResult('step1', '❌ Connection FAILED\n\n' + err.message, false);
        }

        setBtnDisabled('step1', false);
    }

    // ============================================================
    // STEP 2: ADD KEYWORD COLUMNS
    // ============================================================
    async function runStep2() {
        setBtnDisabled('step2', true);
        setStatus('step2', 'RUNNING');
        document.getElementById('step2-log').innerHTML = '';

        try {
            log('step2', 'Checking current filter table structure...');

            var testRes = await fetch(SUPABASE_URL + '/rest/v1/filters?select=product_keywords&limit=1', {
                headers: HEADERS
            });

            if (testRes.ok) {
                log('step2', '✅ Columns already exist! No migration needed.', 'ok');
                setStatus('step2', 'DONE');
                showResult('step2', '✅ Column already exists\n\nThe keyword columns are already in your filters table.', true);
                setBtnDisabled('step2', false);
                return;
            }

            log('step2', 'Columns do not exist yet (status: ' + testRes.status + ')', 'warn');
            log('step2', '', 'info');
            log('step2', '════════════════════════════════════════════════════', 'warn');
            log('step2', 'IMPORTANT: Adding new columns requires SQL access.', 'warn');
            log('step2', 'The anon API key CANNOT modify table schema directly.', 'warn');
            log('step2', '════════════════════════════════════════════════════', 'warn');
            log('step2', '', 'info');
            log('step2', 'Copy the SQL below and run it in Supabase SQL Editor:', 'info');
            log('step2', '', 'info');

            var migrationSQL = '-- Run this in Supabase SQL Editor\n' +
                '-- Go to: https://supabase.com/dashboard/project/zvhuromubukylsxrsfiz/sql/new\n\n' +
                'ALTER TABLE public.filters\n' +
                '    ADD COLUMN IF NOT EXISTS product_keywords jsonb DEFAULT \'[]\'::jsonb,\n' +
                '    ADD COLUMN IF NOT EXISTS negative_keywords jsonb DEFAULT \'[]\'::jsonb,\n' +
                '    ADD COLUMN IF NOT EXISTS required_keywords jsonb DEFAULT \'[]\'::jsonb,\n' +
                '    ADD COLUMN IF NOT EXISTS location_keywords jsonb DEFAULT \'[]\'::jsonb;\n\n' +
                'CREATE INDEX IF NOT EXISTS idx_filters_is_active\n' +
                '    ON public.filters (is_active)\n' +
                '    WHERE is_active = true;\n\n' +
                '-- Verify\n' +
                'SELECT column_name, data_type\n' +
                'FROM information_schema.columns\n' +
                'WHERE table_name = \'filters\'\n' +
                '    AND column_name IN (\n' +
                '        \'product_keywords\', \'negative_keywords\',\n' +
                '        \'required_keywords\', \'location_keywords\'\n' +
                '    )\n' +
                'ORDER BY column_name;';

            log('step2', migrationSQL, 'data');

            setStatus('step2', 'MANUAL');
            showResult('step2',
                '⚠️ MANUAL STEP REQUIRED\n\n' +
                'Adding new columns must be done in Supabase SQL Editor.\n\n' +
                '1. Open: https://supabase.com/dashboard/project/zvhuromubukylsxrsfiz/sql/new\n' +
                '2. Copy the SQL from the log above\n' +
                '3. Paste and click "Run"\n' +
                '4. Come back here and click "Run Step 2" again to verify\n\n' +
                'After running the SQL, this step will auto-detect the columns.',
                false);
        } catch (err) {
            log('step2', 'Error: ' + err.message, 'err');
            setStatus('step2', 'FAILED');
            showResult('step2', '❌ ' + err.message, false);
        }

        setBtnDisabled('step2', false);
    }

    // ============================================================
    // STEP 3: POPULATE KEYWORDS
    // ============================================================
    function extractKeywords(config, useExpansions) {
        var result = { product: [], negative: [], required: [], location: [] };
        config = config || {};

        function addUnique(arr, item) {
            if (!item || typeof item !== 'string') return;
            var lower = item.toLowerCase().trim();
            if (lower && arr.indexOf(lower) === -1) arr.push(lower);
        }

        if (Array.isArray(config.product_names)) {
            for (var i = 0; i < config.product_names.length; i++) {
                var k = config.product_names[i];
                addUnique(result.product, k);
                if (useExpansions && CATEGORY_EXPANSIONS[String(k).toLowerCase()]) {
                    var expanded = CATEGORY_EXPANSIONS[String(k).toLowerCase()];
                    for (var j = 0; j < expanded.length; j++) {
                        addUnique(result.product, expanded[j]);
                    }
                }
            }
        }
        if (Array.isArray(config.keywords)) {
            for (var kk = 0; kk < config.keywords.length; kk++) addUnique(result.product, config.keywords[kk]);
        }
        if (Array.isArray(config.negative_keywords)) {
            for (var nn = 0; nn < config.negative_keywords.length; nn++) addUnique(result.negative, config.negative_keywords[nn]);
        }
        if (Array.isArray(config.required_keywords)) {
            for (var rr = 0; rr < config.required_keywords.length; rr++) addUnique(result.required, config.required_keywords[rr]);
        }
        if (Array.isArray(config.countries)) {
            for (var cc = 0; cc < config.countries.length; cc++) addUnique(result.location, config.countries[cc]);
        }
        if (Array.isArray(config.states)) {
            for (var ss = 0; ss < config.states.length; ss++) addUnique(result.location, config.states[ss]);
        }

        return result;
    }

    async function runStep3() {
        setBtnDisabled('step3', true);
        setStatus('step3', 'RUNNING');
        document.getElementById('step3-log').innerHTML = '';

        var useExpansions = document.getElementById('useExpansions').checked;

        try {
            log('step3', 'Fetching filters from database...');
            var res = await fetch(SUPABASE_URL + '/rest/v1/filters?select=*', {
                headers: HEADERS
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var filters = await res.json();
            log('step3', 'Found ' + filters.length + ' filter(s)', 'ok');

            if (filters.length === 0) {
                log('step3', 'No filters to migrate', 'warn');
                setStatus('step3', 'DONE');
                showResult('step3', '⚠️ No filters found', false);
                setBtnDisabled('step3', false);
                return;
            }

            var successCount = 0;
            var errorCount = 0;

            for (var i = 0; i < filters.length; i++) {
                var filter = filters[i];
                log('step3', '', 'info');
                log('step3', '─── Filter #' + filter.id + ': ' + (filter.filter_name || 'unnamed') + ' ───', 'info');

                if (!('product_keywords' in filter)) {
                    throw new Error('Column "product_keywords" does not exist. Please run Step 2 SQL first.');
                }

                var keywords = extractKeywords(filter.filter_config, useExpansions);

                log('step3', 'Extracted keywords:', 'ok');
                log('step3', '  Product (' + keywords.product.length + '): ' + keywords.product.slice(0, 10).join(', ') + (keywords.product.length > 10 ? '...' : ''), 'data');
                log('step3', '  Negative (' + keywords.negative.length + '): ' + keywords.negative.join(', '), 'data');
                log('step3', '  Required (' + keywords.required.length + '): ' + keywords.required.join(', '), 'data');
                log('step3', '  Location (' + keywords.location.length + '): ' + keywords.location.join(', '), 'data');

                var updateRes = await fetch(SUPABASE_URL + '/rest/v1/filters?id=eq.' + filter.id, {
                    method: 'PATCH',
                    headers: HEADERS,
                    body: JSON.stringify({
                        product_keywords: keywords.product,
                        negative_keywords: keywords.negative,
                        required_keywords: keywords.required,
                        location_keywords: keywords.location,
                        updated_at: new Date().toISOString()
                    })
                });

                if (!updateRes.ok) {
                    var errText = await updateRes.text();
                    log('step3', '  ❌ Update failed: ' + errText.substring(0, 200), 'err');
                    errorCount++;
                } else {
                    log('step3', '  ✅ Updated successfully', 'ok');
                    successCount++;
                }
            }

            log('step3', '', 'info');
            log('step3', '═══════════════════════════════════════', 'info');
            log('step3', 'Migration complete: ' + successCount + ' succeeded, ' + errorCount + ' failed', successCount > 0 ? 'ok' : 'err');

            setStatus('step3', errorCount === 0 ? 'DONE' : 'PARTIAL');
            showResult('step3',
                '✅ Migration complete\n\n' +
                'Success: ' + successCount + '\n' +
                'Failed: ' + errorCount + '\n\n' +
                'Filters updated with keywords from filter_config.' +
                (useExpansions ? ' Category expansions also applied.' : ''),
                errorCount === 0);
        } catch (err) {
            log('step3', 'Error: ' + err.message, 'err');
            setStatus('step3', 'FAILED');
            showResult('step3', '❌ ' + err.message, false);
        }

        setBtnDisabled('step3', false);
    }

    // ============================================================
    // STEP 4: VERIFY
    // ============================================================
    async function runStep4() {
        setBtnDisabled('step4', true);
        setStatus('step4', 'RUNNING');
        document.getElementById('step4-log').innerHTML = '';

        try {
            log('step4', 'Verifying migration...');

            var res = await fetch(SUPABASE_URL + '/rest/v1/filters?select=*', {
                headers: HEADERS
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var filters = await res.json();

            var summary = '📊 MIGRATION VERIFICATION\n\n';
            var allGood = true;

            for (var i = 0; i < filters.length; i++) {
                var f = filters[i];
                log('step4', '', 'info');
                log('step4', 'Filter #' + f.id + ': ' + (f.filter_name || 'unnamed'), 'info');

                var pk = Array.isArray(f.product_keywords) ? f.product_keywords.length : 0;
                var nk = Array.isArray(f.negative_keywords) ? f.negative_keywords.length : 0;
                var rk = Array.isArray(f.required_keywords) ? f.required_keywords.length : 0;
                var lk = Array.isArray(f.location_keywords) ? f.location_keywords.length : 0;

                log('step4', '  Product keywords: ' + pk, pk > 0 ? 'ok' : 'warn');
                log('step4', '  Negative keywords: ' + nk, 'data');
                log('step4', '  Required keywords: ' + rk, 'data');
                log('step4', '  Location keywords: ' + lk, 'data');

                if (pk > 0) {
                    log('step4', '  First 15: ' + f.product_keywords.slice(0, 15).join(', '), 'data');
                }

                summary += 'Filter: ' + (f.filter_name || 'unnamed') + '\n';
                summary += '  Product keywords: ' + pk + '\n';
                summary += '  Negative: ' + nk + '\n';
                summary += '  Location: ' + lk + '\n\n';

                if (pk === 0) allGood = false;
            }

            if (allGood && filters.length > 0) {
                log('step4', '', 'ok');
                log('step4', '✅ All filters have keywords populated!', 'ok');
                setStatus('step4', 'OK');
                showResult('step4', '✅ MIGRATION VERIFIED\n\n' + summary + 'All filters are ready.', true);
            } else {
                log('step4', '', 'warn');
                log('step4', '⚠️ Some filters have 0 product keywords', 'warn');
                setStatus('step4', 'WARN');
                showResult('step4', '⚠️ PARTIAL\n\n' + summary, false);
            }
        } catch (err) {
            log('step4', 'Error: ' + err.message, 'err');
            setStatus('step4', 'FAILED');
            showResult('step4', '❌ ' + err.message, false);
        }

        setBtnDisabled('step4', false);
    }

    // ============================================================
    // RUN ALL STEPS
    // ============================================================
    async function runAllSteps() {
        await runStep1();
        var step1Status = document.getElementById('step1-status').textContent;
        if (step1Status !== 'OK') return;

        await runStep2();
        var step2Status = document.getElementById('step2-status').textContent;
        if (step2Status === 'MANUAL') {
            alert('⚠️ Manual step required. Please run the SQL in Supabase SQL Editor, then click "Run All Steps" again.');
            return;
        }
        if (step2Status !== 'DONE' && step2Status !== 'OK') return;

        await runStep3();
        var step3Status = document.getElementById('step3-status').textContent;
        if (step3Status === 'FAILED') return;

        await runStep4();
    }

    // ============================================================
    // UTILITIES
    // ============================================================
    function clearLogs() {
        ['step1', 'step2', 'step3', 'step4'].forEach(function(s) {
            var logEl = document.getElementById(s + '-log');
            if (logEl) {
                logEl.innerHTML = '';
                logEl.classList.remove('show');
            }
            var resultEl = document.getElementById(s + '-result');
            if (resultEl) {
                resultEl.textContent = '';
                resultEl.classList.remove('show', 'ok', 'err');
            }
            setStatus(s, 'PENDING');
        });
    }

    async function showRawData() {
        var el = document.getElementById('step4-result');
        el.classList.add('show');
        el.textContent = '⏳ Fetching raw data...';

        try {
            var res = await fetch(SUPABASE_URL + '/rest/v1/filters?select=*', {
                headers: HEADERS
            });
            var filters = await res.json();
            el.textContent = JSON.stringify(filters, null, 2);
        } catch (err) {
            el.textContent = '❌ Error: ' + err.message;
            el.classList.add('err');
        }
    }

    // ============================================================
    // EVENT LISTENERS (replaces inline onclick)
    // ============================================================
    function setupEventListeners() {
        // Action buttons
        var actionMap = {
            'runStep1': runStep1,
            'runStep2': runStep2,
            'runStep3': runStep3,
            'runStep4': runStep4,
            'runAllSteps': runAllSteps,
            'clearLogs': clearLogs,
            'showRawData': showRawData
        };

        document.querySelectorAll('[data-action]').forEach(function(el) {
            var action = el.getAttribute('data-action');
            if (actionMap[action]) {
                el.addEventListener('click', actionMap[action]);
            }
        });
    }

    // ============================================================
    // AUTO-RUN STEP 1 ON LOAD
    // ============================================================
    window.addEventListener('DOMContentLoaded', function() {
        setupEventListeners();
        setTimeout(runStep1, 300);
    });
})();