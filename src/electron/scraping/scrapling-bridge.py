#!/usr/bin/env python3
"""
Scrapling Bridge for CoWork OS
Thin stdin/stdout JSON bridge between Node.js and the Scrapling Python library.
Receives JSON commands on stdin, executes Scrapling operations, returns JSON on stdout.
"""

import json
import sys
import asyncio
import time
import traceback
from typing import Any
from urllib.parse import urlparse

# Ensure Scrapling is importable
try:
    import scrapling
    from scrapling import Fetcher, StealthFetcher, PlayWrightFetcher
    SCRAPLING_AVAILABLE = True
    SCRAPLING_VERSION = getattr(scrapling, "__version__", "unknown")
except ImportError:
    SCRAPLING_AVAILABLE = False
    SCRAPLING_VERSION = None


def send_response(data: dict) -> None:
    """Send a JSON response to stdout."""
    line = json.dumps(data, default=str, ensure_ascii=False)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def send_error(error: str, code: str = "ERROR") -> None:
    """Send an error response."""
    send_response({"success": False, "error": error, "code": code})


def check_available() -> bool:
    """Check if Scrapling is installed and return status."""
    if not SCRAPLING_AVAILABLE:
        send_error(
            "Scrapling is not installed. Run: pip install scrapling && scrapling install",
            "NOT_INSTALLED",
        )
        return False
    return True


def get_response_url(response: Any, requested_url: str) -> str:
    """Return the fetcher's final URL when available."""
    return str(response.url) if hasattr(response, "url") else requested_url


def normalize_allowed_hosts(params: dict) -> set[str]:
    """Normalize the host allowlist supplied by the policy-enforcing caller."""
    values = params.get("allowed_hosts", [])
    if not isinstance(values, list):
        return set()
    return {
        str(value).strip().lower().rstrip(".")
        for value in values
        if str(value).strip()
    }


def enforce_same_host_final_url(
    requested_url: str,
    response: Any,
    allowed_hosts: set[str] | None = None,
) -> str:
    """Block unsafe schemes, cross-host redirects, and unexpected final hosts."""
    final_url = get_response_url(response, requested_url)
    requested = urlparse(requested_url)
    final = urlparse(final_url)
    if requested.scheme not in ("http", "https") or final.scheme not in ("http", "https"):
        raise ValueError("Scraping only supports HTTP and HTTPS URLs")
    requested_host = (requested.hostname or "").lower().rstrip(".")
    final_host = (final.hostname or requested_host).lower().rstrip(".")
    if allowed_hosts:
        if requested_host not in allowed_hosts or final_host not in allowed_hosts:
            raise ValueError("Scraping URL host is outside the approved host set")
    if requested_host and final_host and requested_host != final_host:
        raise ValueError("Scraping redirect crossed to a different host")
    return final_url


def get_response_status(response: Any) -> int:
    """Return a normalized HTTP status when the fetcher exposes one."""
    try:
        return int(getattr(response, "status", 200) or 200)
    except (TypeError, ValueError):
        return 200


def classify_response_status(status: int) -> dict[str, Any]:
    """Classify target responses without treating provider errors as scraper crashes."""
    retryable = status in (408, 425, 429) or status >= 500
    blocked = status in (403, 429)
    category = None
    if status == 429:
        category = "rate_limited"
    elif status == 403:
        category = "access_blocked"
    elif retryable:
        category = "upstream_error"
    return {
        "target_blocked": blocked,
        "retryable": retryable,
        **({"status_category": category} if category else {}),
    }


def request_delay_seconds(params: dict) -> float:
    """Return a bounded delay between requests in a batch/session."""
    try:
        delay_ms = float(params.get("request_delay_ms", 0) or 0)
    except (TypeError, ValueError):
        return 0
    return max(0, min(60_000, delay_ms)) / 1000


def wait_between_requests(last_request_at: float | None, delay_seconds: float) -> None:
    """Throttle sequential requests while leaving the first request immediate."""
    if last_request_at is None or delay_seconds <= 0:
        return
    remaining = delay_seconds - (time.monotonic() - last_request_at)
    if remaining > 0:
        time.sleep(remaining)


# ──────────────────────────────────────────────
# Command Handlers
# ──────────────────────────────────────────────


def handle_status(_input: dict) -> None:
    """Return Scrapling installation status."""
    send_response({
        "success": True,
        "installed": SCRAPLING_AVAILABLE,
        "version": SCRAPLING_VERSION,
    })


def handle_scrape_page(params: dict) -> None:
    """Scrape a single URL with anti-bot bypass."""
    if not check_available():
        return

    url = params.get("url")
    if not url:
        send_error("url is required")
        return

    fetcher_type = params.get("fetcher", "default")
    selector = params.get("selector")
    wait_for = params.get("wait_for")
    timeout = params.get("timeout", 30000)
    headless = params.get("headless", True)
    proxy = params.get("proxy")
    extract_links = params.get("extract_links", False)
    extract_images = params.get("extract_images", False)
    extract_tables = params.get("extract_tables", False)

    try:
        # Select fetcher based on type
        if fetcher_type == "stealth":
            fetcher = StealthFetcher(auto_match=True)
        elif fetcher_type == "playwright":
            fetcher = PlayWrightFetcher(auto_match=True)
        else:
            fetcher = Fetcher(auto_match=True)

        # Build fetch kwargs
        fetch_kwargs: dict[str, Any] = {"timeout": timeout / 1000}
        if proxy:
            fetch_kwargs["proxies"] = {"http": proxy, "https": proxy}

        # For browser-based fetchers
        if fetcher_type in ("stealth", "playwright"):
            fetch_kwargs["headless"] = headless
            if wait_for:
                fetch_kwargs["wait_selector"] = wait_for

        # Perform the fetch
        response = fetcher.get(url, **fetch_kwargs)
        final_url = enforce_same_host_final_url(url, response, normalize_allowed_hosts(params))

        # Extract content
        status = get_response_status(response)
        result: dict[str, Any] = {
            "success": True,
            "url": final_url,
            "status": status,
        }
        result.update(classify_response_status(status))
        if status >= 400:
            result["success"] = False
            result["error"] = f"Target returned HTTP {status}"

        # Get page title
        title_els = response.css("title")
        result["title"] = title_els[0].text if title_els else ""

        # Extract content based on selector or full page
        if selector:
            elements = response.css(selector)
            result["content"] = "\n".join(el.text for el in elements if el.text)
            result["html"] = "\n".join(str(el) for el in elements)
            result["element_count"] = len(elements)
        else:
            # Get main content area or body
            main = response.css("main") or response.css("article") or response.css("body")
            if main:
                result["content"] = main[0].text or ""
                result["html"] = str(main[0])
            else:
                result["content"] = response.text or ""
                result["html"] = str(response)

        # Optional: extract links
        if extract_links:
            links = []
            for a in response.css("a[href]"):
                href = a.attrib.get("href", "")
                text = a.text or ""
                if href:
                    links.append({"href": href, "text": text.strip()})
            result["links"] = links

        # Optional: extract images
        if extract_images:
            images = []
            for img in response.css("img[src]"):
                src = img.attrib.get("src", "")
                alt = img.attrib.get("alt", "")
                if src:
                    images.append({"src": src, "alt": alt})
            result["images"] = images

        # Optional: extract tables
        if extract_tables:
            tables = []
            for table in response.css("table"):
                rows = []
                for tr in table.css("tr"):
                    cells = [td.text.strip() for td in tr.css("td, th") if td.text]
                    if cells:
                        rows.append(cells)
                if rows:
                    tables.append(rows)
            result["tables"] = tables

        # Truncate content if too large
        max_len = params.get("max_content_length", 100000)
        if len(result.get("content", "")) > max_len:
            result["content"] = result["content"][:max_len] + "\n... [truncated]"
            result["truncated"] = True

        send_response(result)

    except Exception as e:
        send_error(f"Scrape failed: {str(e)}", "SCRAPE_ERROR")


def handle_scrape_multiple(params: dict) -> None:
    """Scrape multiple URLs in sequence."""
    if not check_available():
        return

    urls = params.get("urls", [])
    if not urls:
        send_error("urls array is required")
        return

    results = []
    fetcher_type = params.get("fetcher", "default")
    selector = params.get("selector")
    max_content_length = params.get("max_content_length", 50000)
    timeout = params.get("timeout", 30000)
    proxy = params.get("proxy")
    delay_seconds = request_delay_seconds(params)

    try:
        if fetcher_type == "stealth":
            fetcher = StealthFetcher(auto_match=True)
        elif fetcher_type == "playwright":
            fetcher = PlayWrightFetcher(auto_match=True)
        else:
            fetcher = Fetcher(auto_match=True)

        last_request_at = None
        for url in urls[:20]:  # Cap at 20 URLs per batch
            try:
                wait_between_requests(last_request_at, delay_seconds)
                fetch_kwargs: dict[str, Any] = {"timeout": timeout / 1000}
                if proxy:
                    fetch_kwargs["proxies"] = {"http": proxy, "https": proxy}
                response = fetcher.get(url, **fetch_kwargs)
                last_request_at = time.monotonic()
                final_url = enforce_same_host_final_url(
                    url,
                    response,
                    normalize_allowed_hosts(params),
                )
                status = get_response_status(response)

                title_els = response.css("title")
                title = title_els[0].text if title_els else ""

                if selector:
                    elements = response.css(selector)
                    content = "\n".join(el.text for el in elements if el.text)
                else:
                    main = response.css("main") or response.css("article") or response.css("body")
                    content = main[0].text if main else (response.text or "")

                if len(content) > max_content_length:
                    content = content[:max_content_length] + "\n... [truncated]"

                results.append({
                    "url": final_url,
                    "success": status < 400,
                    "status": status,
                    "title": title,
                    "content": content,
                    "content_length": len(content),
                })
                results[-1].update(classify_response_status(status))
                if status >= 400:
                    results[-1]["error"] = f"Target returned HTTP {status}"
            except Exception as e:
                results.append({
                    "url": url,
                    "success": False,
                    "error": str(e),
                })

        send_response({"success": True, "results": results, "total": len(results)})

    except Exception as e:
        send_error(f"Multi-scrape failed: {str(e)}", "SCRAPE_ERROR")


def handle_extract_structured(params: dict) -> None:
    """Extract structured data from a page (tables, lists, product cards, etc.)."""
    if not check_available():
        return

    url = params.get("url")
    if not url:
        send_error("url is required")
        return

    extract_type = params.get("extract_type", "auto")
    selectors = params.get("selectors", {})
    fetcher_type = params.get("fetcher", "default")
    timeout = params.get("timeout", 30000)
    proxy = params.get("proxy")

    try:
        if fetcher_type == "stealth":
            fetcher = StealthFetcher(auto_match=True)
        elif fetcher_type == "playwright":
            fetcher = PlayWrightFetcher(auto_match=True)
        else:
            fetcher = Fetcher(auto_match=True)

        fetch_kwargs: dict[str, Any] = {"timeout": timeout / 1000}
        if proxy:
            fetch_kwargs["proxies"] = {"http": proxy, "https": proxy}
        response = fetcher.get(url, **fetch_kwargs)
        final_url = enforce_same_host_final_url(url, response, normalize_allowed_hosts(params))
        status = get_response_status(response)
        result: dict[str, Any] = {
            "success": status < 400,
            "url": final_url,
            "status": status,
            "data": {},
        }
        result.update(classify_response_status(status))
        if status >= 400:
            result["error"] = f"Target returned HTTP {status}"

        if extract_type in ("auto", "tables"):
            tables = []
            for table in response.css("table"):
                headers = [th.text.strip() for th in table.css("thead th, tr:first-child th") if th.text]
                rows = []
                body_rows = table.css("tbody tr") or table.css("tr")
                for tr in body_rows:
                    cells = [td.text.strip() for td in tr.css("td") if td.text]
                    if cells:
                        rows.append(cells)
                if headers or rows:
                    tables.append({"headers": headers, "rows": rows})
            result["data"]["tables"] = tables

        if extract_type in ("auto", "lists"):
            lists = []
            for ul in response.css("ul, ol"):
                items = [li.text.strip() for li in ul.css("li") if li.text]
                if items:
                    lists.append(items)
            result["data"]["lists"] = lists

        if extract_type in ("auto", "headings"):
            headings = []
            for level in range(1, 7):
                for h in response.css(f"h{level}"):
                    if h.text:
                        headings.append({"level": level, "text": h.text.strip()})
            result["data"]["headings"] = headings

        if extract_type == "custom" and selectors:
            custom = {}
            for key, sel in selectors.items():
                elements = response.css(sel)
                custom[key] = [el.text.strip() for el in elements if el.text]
            result["data"]["custom"] = custom

        if extract_type in ("auto", "meta"):
            meta = {}
            for m in response.css("meta[name], meta[property]"):
                name = m.attrib.get("name") or m.attrib.get("property", "")
                content = m.attrib.get("content", "")
                if name and content:
                    meta[name] = content
            result["data"]["meta"] = meta

        send_response(result)

    except Exception as e:
        send_error(f"Extraction failed: {str(e)}", "EXTRACT_ERROR")


def handle_scrape_session(params: dict) -> None:
    """Manage a persistent scraping session (login -> navigate -> extract)."""
    if not check_available():
        return

    action = params.get("action", "create")
    steps = params.get("steps", [])
    headless = params.get("headless", True)
    timeout = params.get("timeout", 30000)
    proxy = params.get("proxy")
    delay_seconds = request_delay_seconds(params)

    try:
        fetcher = PlayWrightFetcher(auto_match=True)

        results = []
        last_request_at = None
        for step in steps:
            step_action = step.get("action")
            step_url = step.get("url")
            step_selector = step.get("selector")
            step_value = step.get("value")
            step_wait = step.get("wait_for")

            if step_action == "navigate" and step_url:
                wait_between_requests(last_request_at, delay_seconds)
                kwargs: dict[str, Any] = {"headless": headless}
                kwargs["timeout"] = timeout / 1000
                if proxy:
                    kwargs["proxies"] = {"http": proxy, "https": proxy}
                if step_wait:
                    kwargs["wait_selector"] = step_wait
                response = fetcher.get(step_url, **kwargs)
                last_request_at = time.monotonic()
                final_url = enforce_same_host_final_url(
                    step_url,
                    response,
                    normalize_allowed_hosts(params),
                )
                status = get_response_status(response)
                title_els = response.css("title")
                result = {
                    "action": "navigate",
                    "url": final_url,
                    "status": status,
                    "title": title_els[0].text if title_els else "",
                    "success": status < 400,
                }
                result.update(classify_response_status(status))
                if status >= 400:
                    result["error"] = f"Target returned HTTP {status}"
                results.append(result)
            elif step_action == "extract" and step_selector:
                # Use the last response
                if hasattr(fetcher, "_last_response"):
                    response = fetcher._last_response
                    elements = response.css(step_selector)
                    results.append({
                        "action": "extract",
                        "selector": step_selector,
                        "data": [el.text.strip() for el in elements if el.text],
                        "count": len(elements),
                        "success": True,
                    })
                else:
                    results.append({
                        "action": "extract",
                        "success": False,
                        "error": "No page loaded yet",
                    })
            else:
                results.append({
                    "action": step_action,
                    "success": False,
                    "error": f"Unknown action: {step_action}",
                })

        send_response({"success": True, "results": results})

    except Exception as e:
        send_error(f"Session failed: {str(e)}", "SESSION_ERROR")


# ──────────────────────────────────────────────
# Main Loop
# ──────────────────────────────────────────────


HANDLERS = {
    "status": handle_status,
    "scrape_page": handle_scrape_page,
    "scrape_multiple": handle_scrape_multiple,
    "extract_structured": handle_extract_structured,
    "scrape_session": handle_scrape_session,
}


def main() -> None:
    """Read JSON commands from stdin, dispatch to handlers, write JSON to stdout."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            command = json.loads(line)
        except json.JSONDecodeError as e:
            send_error(f"Invalid JSON: {str(e)}", "PARSE_ERROR")
            continue

        action = command.get("action")
        params = command.get("params", {})

        handler = HANDLERS.get(action)
        if handler:
            try:
                handler(params)
            except Exception as e:
                send_error(f"Handler error: {str(e)}\n{traceback.format_exc()}", "HANDLER_ERROR")
        else:
            send_error(f"Unknown action: {action}", "UNKNOWN_ACTION")


if __name__ == "__main__":
    main()
