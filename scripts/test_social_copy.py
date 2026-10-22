#!/usr/bin/env python3
"""
TDD tests for social media copy validation.

Tests:
1. X/Twitter: No link in main post, link in reply, ≤280 chars
2. Facebook: No link in main post, link in first comment, value-first
3. Structure: All required sections present
4. Content: No private data leaks (reuses CV privacy rules)

Run: python3 scripts/test_social_copy.py [social_file.md]
"""

import re
import sys
from pathlib import Path


PROJECT_DIR = Path(__file__).parent.parent
SOCIAL_DIR = PROJECT_DIR / "social-output"


def load_social(filepath: str = None) -> str:
    if filepath:
        return Path(filepath).read_text()
    # Find most recent social file
    files = sorted(SOCIAL_DIR.glob("*.md"), key=lambda f: f.stat().st_mtime, reverse=True)
    if not files:
        raise FileNotFoundError("No social copy files in social-output/")
    return files[0].read_text()


def parse_sections(content: str) -> dict:
    """Parse social copy markdown into sections.
    
    H2 = platform (X/Twitter, Facebook)
    H3 = sub-section (Main Post, Reply, First Comment)
    
    Keys: "Platform::Sub Section"
    """
    sections = {}
    current_platform = None
    current_subsection = None
    current_text = []

    def save_current():
        if current_platform and current_subsection:
            key = f"{current_platform}::{current_subsection}"
            sections[key] = "\n".join(current_text).strip()
        elif current_platform:
            sections[current_platform] = "\n".join(current_text).strip()

    for line in content.split("\n"):
        # H1 = title (skip)
        if line.startswith("# ") and not line.startswith("## "):
            continue
        # H2 = platform
        elif line.startswith("## "):
            save_current()
            current_platform = line.replace("## ", "").strip()
            current_subsection = None
            current_text = []
        # H3 = sub-section (sibling, not nested)
        elif line.startswith("### "):
            save_current()
            current_subsection = line.replace("### ", "").strip()
            current_text = []
        else:
            current_text.append(line)

    save_current()
    return sections


class TestStructure:
    """Social copy must have all required sections."""

    def __init__(self, content):
        self.content = content
        self.sections = parse_sections(content)

    def test_has_twitter_section(self):
        """Must have X/Twitter section."""
        found = any("twitter" in k.lower() or "x/" in k.lower() for k in self.sections)
        assert found, f"No X/Twitter section found. Sections: {list(self.sections.keys())}"

    def test_has_facebook_section(self):
        """Must have Facebook section."""
        found = any("facebook" in k.lower() for k in self.sections)
        assert found, f"No Facebook section found. Sections: {list(self.sections.keys())}"

    def test_has_twitter_main_and_reply(self):
        """Twitter must have main post and reply with link."""
        keys = [k.lower() for k in self.sections]
        has_main = any("main post" in k for k in keys)
        has_reply = any("reply" in k for k in keys)
        assert has_main, "Twitter missing 'Main Post' section"
        assert has_reply, "Twitter missing 'Reply' section with link"

    def test_has_facebook_main_and_comment(self):
        """Facebook must have main post and first comment with link."""
        keys = [k.lower() for k in self.sections]
        has_main = any("facebook" in k and "main" in k for k in keys)
        has_comment = any("comment" in k for k in keys)
        assert has_main, "Facebook missing 'Main Post' section"
        assert has_comment, "Facebook missing 'First Comment' section with link"


class TestTwitter:
    """X/Twitter copy must follow platform rules."""

    def __init__(self, content):
        self.sections = parse_sections(content)
        # Find twitter main post
        self.main = ""
        self.reply = ""
        for key, val in self.sections.items():
            kl = key.lower()
            if ("twitter" in kl or "x/" in kl) and "main" in kl:
                self.main = val
            elif ("twitter" in kl or "x/" in kl) and "reply" in kl:
                self.reply = val
            elif "alt" in kl and ("twitter" in kl or "x/" in kl or "thread" in kl):
                pass  # Alt posts are optional

    def test_main_post_no_link(self):
        """Main post must NOT contain a URL (suppresses reach)."""
        urls = re.findall(r'https?://\S+', self.main)
        assert not urls, f"Twitter main post contains link (bad for reach): {urls}"

    def test_reply_has_link(self):
        """Reply must contain the blog URL."""
        urls = re.findall(r'https?://\S+', self.reply)
        assert urls, "Twitter reply must contain blog link"

    def test_main_post_char_limit(self):
        """Main post must be ≤280 characters (excluding hashtags line)."""
        # Strip markdown formatting for char count
        text = self.main
        text = re.sub(r'^>?\s*', '', text, flags=re.MULTILINE)  # Remove blockquotes
        text = re.sub(r'\*\*([^*]+)\*\*', r'\1', text)  # Remove bold
        text = re.sub(r'\*([^*]+)\*', r'\1', text)  # Remove italic
        lines = [l.strip() for l in text.strip().split("\n") if l.strip()]
        # Main content without the hashtag line
        content_lines = [l for l in lines if not l.startswith("#")]
        content_text = " ".join(content_lines)
        assert len(content_text) <= 280, f"Twitter main post is {len(content_text)} chars (max 280)"

    def test_has_hashtags(self):
        """Main post should include hashtags."""
        assert "#" in self.main, "Twitter main post missing hashtags"

    def test_max_5_hashtags(self):
        """Maximum 5 hashtags."""
        hashtags = re.findall(r'#\w+', self.main)
        assert len(hashtags) <= 5, f"Too many hashtags: {len(hashtags)} (max 5)"


class TestFacebook:
    """Facebook copy must follow platform rules."""

    def __init__(self, content):
        self.sections = parse_sections(content)
        self.main = ""
        self.comment = ""
        for key, val in self.sections.items():
            kl = key.lower()
            if "facebook" in kl and "main" in kl:
                self.main = val
            elif "comment" in kl:
                self.comment = val

    def test_main_post_no_link(self):
        """Main post must NOT contain a URL (Facebook penalizes links in post)."""
        urls = re.findall(r'https?://\S+', self.main)
        assert not urls, f"Facebook main post contains link (penalized by algorithm): {urls}"

    def test_first_comment_has_link(self):
        """First comment must contain the blog URL."""
        urls = re.findall(r'https?://\S+', self.comment)
        assert urls, "Facebook first comment must contain blog link"

    def test_main_post_not_empty(self):
        """Main post must have substantial content."""
        assert len(self.main) > 100, f"Facebook main post too short ({len(self.main)} chars)"

    def test_ends_with_question(self):
        """Facebook main post should end with engagement question."""
        assert "?" in self.main, "Facebook post should include an engagement question"


class TestPrivacy:
    """Social copy must not leak private data."""

    def __init__(self, content):
        self.content = content

    def test_no_dollar_amounts(self):
        """No dollar amounts in social copy."""
        matches = re.findall(r'\$[\d,.]+[MKBmkb]?\+?', self.content)
        assert not matches, f"Found dollar amounts in social copy: {matches}"

    def test_no_specific_cert_names(self):
        """No DITSCAP/DIACAP/NIST-xxx in social copy."""
        forbidden = [r'\bDITSCAP\b', r'\bDIACAP\b', r'\bNIST\s+800-\d+']
        for pattern in forbidden:
            matches = re.findall(pattern, self.content, re.IGNORECASE)
            assert not matches, f"Found forbidden cert name in social: {matches}"

    def test_no_company_names(self):
        """No employer company names in social copy."""
        forbidden = [r'\bKeres\b', r'\bTecumseh\b', r'\bEG&G\b']
        for pattern in forbidden:
            matches = re.findall(pattern, self.content, re.IGNORECASE)
            assert not matches, f"Found company name in social: {matches}"


def run_tests(filepath=None):
    """Run all tests and report results."""
    print("🔍 Social Copy Audit")
    print("=" * 60)

    try:
        content = load_social(filepath)
    except FileNotFoundError as e:
        print(f"  ❌ {e}")
        return 1

    passed = 0
    failed = 0
    errors = []

    for test_class in [TestStructure, TestTwitter, TestFacebook, TestPrivacy]:
        instance = test_class(content)
        print(f"\n{test_class.__doc__.strip()}")
        print("-" * 40)

        for method_name in sorted(dir(instance)):
            if not method_name.startswith('test_'):
                continue

            method = getattr(instance, method_name)
            doc = method.__doc__ or method_name

            try:
                method()
                print(f"  ✅ {doc}")
                passed += 1
            except AssertionError as e:
                print(f"  ❌ {doc}")
                print(f"     {e}")
                failed += 1
                errors.append((method_name, str(e)))
            except Exception as e:
                print(f"  ❌ {doc}")
                print(f"     ERROR: {e}")
                failed += 1
                errors.append((method_name, str(e)))

    print(f"\n{'=' * 60}")
    print(f"Results: {passed} passed, {failed} failed")

    if errors:
        print(f"\n❌ SOCIAL AUDIT FAILED")
        for name, error in errors:
            print(f"  • {name}: {error}")
        return 1
    else:
        print(f"\n✅ SOCIAL AUDIT PASSED")
        return 0


if __name__ == "__main__":
    filepath = sys.argv[1] if len(sys.argv) > 1 else None
    sys.exit(run_tests(filepath))
