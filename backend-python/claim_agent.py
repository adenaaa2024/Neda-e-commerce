from pathlib import Path

from dotenv import load_dotenv

env_path = Path(__file__).resolve().parent / ".env"
load_dotenv(dotenv_path=env_path)

import os
import asyncio
import time
from datetime import datetime
from google import genai
from supabase import create_client, Client, SupabaseException
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException
from webdriver_manager.chrome import ChromeDriverManager

class ClaimProcessorAgent:
    def __init__(self, organization_id: str):
        # 1. Database Configuration
        self.org_id = organization_id
        self.supabase_url = os.getenv("NEXT_PUBLIC_SUPABASE_URL")
        self.supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        print(f"DEBUG: NEXT_PUBLIC_SUPABASE_URL found is {self.supabase_url}")
        print(f"DEBUG: Key found is {self.supabase_key}")
        try:
            self.supabase: Client = create_client(self.supabase_url, self.supabase_key)
        except SupabaseException as e:
            if not self.supabase_url:
                print(
                    "[!] Supabase client could not be created: NEXT_PUBLIC_SUPABASE_URL is missing or empty. "
                    "Set NEXT_PUBLIC_SUPABASE_URL in your environment or .env (loaded via python-dotenv)."
                )
            else:
                print(f"[!] Supabase client could not be created: {e}")
            raise
        
        # 2. Portal Configuration (Mock Amazon Portal on Vercel)
        self.mock_portal_url = "https://mock-amazon-portal.vercel.app/"
        self.gemini_api_key = os.getenv("GEMINI_API_KEY")
        self.gemini_client = None
        self.gemini_model_name = "gemini-1.5-flash"
        if self.gemini_api_key:
            self.gemini_client = genai.Client(api_key=self.gemini_api_key)
        else:
            print("[!] GEMINI_API_KEY is missing. AI navigation is disabled.")

    async def check_permissions(self) -> bool:
        """Checks organization_settings for sync status and daily limits."""
        try:
            response = self.supabase.table("organization_settings") \
                .select("is_auto_sync_enabled, max_daily_claims") \
                .eq("organization_id", self.org_id) \
                .execute()

            if not response.data:
                print("[-] Org ID not found in database. Please check your Supabase table.")
                return False

            settings = response.data[0]
            if not settings.get("is_auto_sync_enabled"):
                print(f"[-] Access Denied: Agent disabled for Org {self.org_id}")
                return False

            # Check daily limit
            today = datetime.now().date().isoformat()
            count_resp = self.supabase.table("claims") \
                .select("id", count="exact") \
                .eq("organization_id", self.org_id) \
                .gte("created_at", today).execute()

            if count_resp.count >= settings.get("max_daily_claims", 0):
                print(f"[-] Limit Reached: Daily quota full for Org {self.org_id}")
                return False

            return True
        except Exception as e:
            print(f"[!] Auth Error: {e}")
            return False

    def run_selenium_navigation(self, order_id, claim_type):
        """Navigates the Mock Amazon Portal using Selenium."""
        options = webdriver.ChromeOptions()
        # options.add_argument('--headless') # Uncomment to run without opening browser window
        driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=options)
        wait = WebDriverWait(driver, 15)

        try:
            print(f"[*] Navigating to: {self.mock_portal_url}")
            driver.get(self.mock_portal_url)
            driver.maximize_window()
            if not self.gemini_client:
                print("[-] Gemini client is not configured. Set GEMINI_API_KEY first.")
                return None

            goal = f"File a {claim_type} claim for order {order_id}"
            max_ai_steps = 8
            for step in range(max_ai_steps):
                # Exit AI loop once we reach the claim form.
                order_fields = driver.find_elements(By.ID, "order_id")
                if order_fields:
                    break

                page_elements = self.get_clickable_elements(driver)
                if not page_elements:
                    print("[-] No visible clickable elements found on page.")
                    return None

                next_action_text = self.decide_next_action(page_elements, goal)
                if not next_action_text:
                    print("[-] Gemini did not return a clickable action.")
                    return None

                print(f"[*] Gemini chose: {next_action_text}")
                if not self.click_element_by_text(driver, wait, next_action_text):
                    print(f"[-] Could not click Gemini-selected action: {next_action_text}")
                    return None

            try:
                print(f"[*] Submitting Claim for Order: {order_id}")
                order_el = wait.until(EC.element_to_be_clickable((By.ID, "order_id")))
                order_el.send_keys(order_id)
            except TimeoutException:
                print("[-] Timeout: field 'order_id' was not found or not clickable within 15s.")
                return None

            try:
                claim_el = wait.until(EC.element_to_be_clickable((By.ID, "claim_type")))
                claim_el.send_keys(claim_type)
            except TimeoutException:
                print("[-] Timeout: field 'claim_type' was not found or not clickable within 15s.")
                return None

            try:
                wait.until(EC.element_to_be_clickable((By.ID, "submit_claim"))).click()
            except TimeoutException:
                print("[-] Timeout: button 'submit_claim' was not found or not clickable within 15s.")
                return None

            try:
                status_el = wait.until(EC.visibility_of_element_located((By.ID, "status_message")))
                status = status_el.text
            except TimeoutException:
                print("[-] Timeout: element 'status_message' was not visible within 15s.")
                return None

            print(f"[+] Result: {status}")
            return status

        finally:
            driver.quit()

    def get_clickable_elements(self, driver):
        """Returns visible clickable button/link texts from the current page."""
        raw_elements = driver.find_elements(
            By.XPATH, "//button[normalize-space()] | //a[normalize-space()]"
        )
        texts = []
        seen = set()
        for el in raw_elements:
            text = el.text.strip()
            if text and el.is_displayed() and el.is_enabled() and text not in seen:
                texts.append(text)
                seen.add(text)
        return texts

    def decide_next_action(self, page_elements, goal):
        """Uses Gemini to choose the next button/link text to click."""
        prompt = (
            "You are a web navigation assistant. You must click through a sequence of pages by "
            "choosing ONE visible button or link from the list I provide.\n\n"
            f"Goal: {goal}.\n\n"
            f"Visible clickable buttons/links on this page (Python list, exact labels): {page_elements}\n\n"
            "Rules:\n"
            "- Reply with ONE line only.\n"
            "- Reply with ONLY the exact visible text of the single button/link to click next "
            "(examples: Help, Manage support cases).\n"
            "- That text MUST match one entry in the list above character-for-character (same spelling "
            "and casing as shown).\n"
            "- Do not add quotes, labels, punctuation, explanations, markdown, or any other words."
        )
        try:
            time.sleep(2)  # ۲ ثانیه استراحت برای اینکه گوگل عصبی نشود!
            response = self.gemini_client.models.generate_content(
                model=self.gemini_model_name,
                contents=prompt,
            )
            raw = (response.text or "").strip()
            choice = raw.splitlines()[0].strip().strip('"').strip("'") if raw else ""
            return choice or None
        except Exception as e:
            print(f"[!] Gemini decision error: {e}")
            return None

    def click_element_by_text(self, driver, wait, text):
        """Clicks a visible element by exact text, with a contains-text fallback."""
        normalized = " ".join(text.split())
        selectors = [
            f"//button[normalize-space()='{normalized}'] | //a[normalize-space()='{normalized}']",
            (
                f"//button[contains(normalize-space(), '{normalized}')] | "
                f"//a[contains(normalize-space(), '{normalized}')]"
            ),
        ]
        for xpath in selectors:
            try:
                el = wait.until(EC.element_to_be_clickable((By.XPATH, xpath)))
                driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", el)
                el.click()
                return True
            except TimeoutException:
                continue
        return False

    async def start_process(self, order_id, claim_type):
        print("[!] DB is empty - Bypassing permissions for local testing...")
        return self.run_selenium_navigation(order_id, claim_type)

# --- Execution for Testing ---
if __name__ == "__main__":
    # Replace with organization_id from organization_settings in Supabase (must match an existing row).
    ORG_ID = "PASTE_YOUR_ORGANIZATION_ID_HERE"
    agent = ClaimProcessorAgent(ORG_ID)
    asyncio.run(agent.start_process("114-9988776-5544332", "DAMAGED"))