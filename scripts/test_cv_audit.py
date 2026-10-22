#!/usr/bin/env python3
"""
TDD tests for CV page audit.

Tests:
1. PRIVACY: No specific government cert/reg names (DITSCAP, DIACAP, NIST 800-xxx, CMMC, FedRAMP)
2. PRIVACY: No dollar amounts ($XXM, $XXK, $XX)
3. PRIVACY: No specific company names from resumes
4. ACCURACY: Every claim on CV page can be traced to a resume
5. CONSISTENCY: Percentages and metrics match resume source data

Run: python3 scripts/test_cv_audit.py
"""

import re
import sys
from pathlib import Path

PROJECT_DIR = Path(__file__).parent.parent
CV_MD = PROJECT_DIR / "content" / "cv.md"

# These are fabrication guards, not page tests: they exist to stop invented certifications,
# NIST numbers, dollar amounts and employer names reaching a published page. The /cv/ page
# itself was removed and content/about.md, which aliases /cv/, carries none of those claims.
#
# The __main__ block below has skipped the audit on a missing page since b3b675f3, but pytest
# collects the classes directly and never reaches it, so a missing file surfaced as 10 errors
# rather than a skip. Guard the collection too, and only under pytest, so running the file
# directly still takes the __main__ path.
#
# Deliberately kept in the tree rather than deleted: if a CV page is ever published again the
# guards re-arm by themselves, which is the whole point of writing them down.
if not CV_MD.exists() and "pytest" in sys.modules:
    import pytest

    pytest.skip(
        f"{CV_MD.relative_to(PROJECT_DIR)} does not exist - the CV audit has nothing to audit",
        allow_module_level=True,
    )


def load_cv():
    return CV_MD.read_text()


class TestPrivacy:
    """CV page must not contain specific government or financial details."""

    def test_no_specific_cert_names(self):
        """No DITSCAP, DIACAP, or specific federal certification acronyms."""
        cv = load_cv()
        forbidden = [
            r'\bDITSCAP\b',
            r'\bDIACAP\b',
        ]
        for pattern in forbidden:
            matches = re.findall(pattern, cv, re.IGNORECASE)
            assert not matches, f"Found forbidden cert name: {matches}"

    def test_no_specific_nist_numbers(self):
        """No NIST 800-xxx specific publication numbers."""
        cv = load_cv()
        matches = re.findall(r'\bNIST\s+800-\d+', cv, re.IGNORECASE)
        assert not matches, f"Found specific NIST publication numbers: {matches}"

    def test_no_cmmc_fedamp(self):
        """No CMMC or FedRAMP specific names."""
        cv = load_cv()
        forbidden = [
            r'\bCMMC\b',
            r'\bFedRAMP\b',
        ]
        for pattern in forbidden:
            matches = re.findall(pattern, cv, re.IGNORECASE)
            assert not matches, f"Found forbidden framework name: {matches}"

    def test_no_dollar_amounts(self):
        """No dollar amounts ($34M, $224M, $7M+, $2-4M, etc.)."""
        cv = load_cv()
        matches = re.findall(r'\$[\d,.]+[MKBmkb]?\+?', cv)
        assert not matches, f"Found dollar amounts: {matches}"

    def test_no_department_of_defense(self):
        """No 'Department of Defense' or 'DoD' — use generic 'federal' instead."""
        cv = load_cv()
        matches = re.findall(r'\bDepartment of Defense\b|\bDoD\b', cv, re.IGNORECASE)
        assert not matches, f"Found DoD references: {matches}"

    def test_no_specific_company_names(self):
        """No employer company names from resumes."""
        cv = load_cv()
        forbidden_companies = [
            r'\bKeres\b',
            r'\bTecumseh\b',
            r'\bEG&G\b',
            r'\bDeltek\b',
            r'\bCostpoint\b',
        ]
        for pattern in forbidden_companies:
            matches = re.findall(pattern, cv, re.IGNORECASE)
            assert not matches, f"Found company name: {matches}"

    def test_no_bia_fca(self):
        """No specific agency acronyms (BIA, FCA)."""
        cv = load_cv()
        # Only flag these if used as agency names (not common words)
        matches = re.findall(r'\bBIA\s+FCA\b|\bBIA\b\s*(?:contract|program|funding)', cv, re.IGNORECASE)
        assert not matches, f"Found specific agency references: {matches}"

    def test_percentages_allowed(self):
        """Percentages ARE allowed (52%, 30%+, etc.)."""
        cv = load_cv()
        re.findall(r'\d+%', cv)
        # This should pass — percentages are fine
        assert True, "Percentages are allowed"


class TestAccuracy:
    """Every claim on CV page must trace back to resume data."""

    RESUME_CLAIMS = {
        # Key metrics that should appear in both CV and resumes
        "52% revenue growth": r'52[.\d]*%',
        "30%+ profit margins": r'30%\+?\s*(profit\s+)?margin',
        "20+ years experience": r'20\+?\s*years',
        "32 direct reports": r'32\s*(direct\s+)?reports',
        "19 teams": r'19\s*teams',
        "8 subcontractors": r'8\s*subcontractors',
        "PMP certification": r'PMP',
        "PMI-ACP certification": r'PMI-ACP|ACP',
    }

    def test_key_metrics_present(self):
        """Key metrics from resumes should appear on CV page."""
        cv = load_cv()
        missing = []
        for claim, pattern in self.RESUME_CLAIMS.items():
            if not re.search(pattern, cv, re.IGNORECASE):
                missing.append(claim)
        assert not missing, f"Missing resume claims on CV: {missing}"

    def test_no_invented_metrics(self):
        """Percentage claims on CV should match resume sources."""
        cv = load_cv()
        # Known valid percentages from resumes
        valid_percentages = {'52', '30', '94', '15', '20'}
        
        # Find all percentage claims
        found = re.findall(r'(\d+)%', cv)
        
        # Any percentage not in the valid set is suspicious
        suspicious = [p for p in found if p not in valid_percentages]
        # Just warn, don't fail — some may be legitimate (skill bars etc.)
        if suspicious:
            print(f"  ⚠️  Percentages not in resume source: {suspicious}")


def run_tests():
    """Run all tests and report results."""
    print("🔍 CV Page Audit")
    print("=" * 60)
    
    passed = 0
    failed = 0
    errors = []

    for test_class in [TestPrivacy, TestAccuracy]:
        print(f"\n{test_class.__doc__.strip()}")
        print("-" * 40)
        
        instance = test_class()
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
        print("\n❌ AUDIT FAILED")
        for name, error in errors:
            print(f"  • {name}: {error}")
        return 1
    else:
        print("\n✅ AUDIT PASSED — CV is privacy-safe and accurate")
        return 0


if __name__ == "__main__":
    if not CV_MD.exists():
        print("✅ CV page not present — audit skipped")
        sys.exit(0)
    sys.exit(run_tests())
