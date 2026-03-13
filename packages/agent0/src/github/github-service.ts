// github-service.ts - GitHub API client using ISV access token
import axios from 'axios';

// ============================================================================
// GitHub Service
// ============================================================================

export class GitHubService {
  /**
   * Post a comment on a GitHub pull request
   * Uses the ISV access token obtained via OAuth STS brokered consent
   */
  static async commentOnPR(
    accessToken: string,
    owner: string,
    repo: string,
    prNumber: number,
    body: string
  ): Promise<{ success: boolean; commentUrl?: string; error?: string }> {
    try {
      const response = await axios.post(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${prNumber}/comments`,
        { body },
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }
      );

      console.log(`✅ GitHub: Comment posted on ${owner}/${repo}#${prNumber}`);
      return {
        success: true,
        commentUrl: response.data.html_url,
      };
    } catch (error: any) {
      const status = error.response?.status;
      const message = error.response?.data?.message || error.message;
      console.error(`❌ GitHub API error (${status}):`, message);
      console.error(`   URL: https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`);
      console.error(`   Response headers:`, JSON.stringify(error.response?.headers || {}, null, 2));
      console.error(`   Response body:`, JSON.stringify(error.response?.data || {}, null, 2));
      console.error(`   Token prefix: ${accessToken.substring(0, 8)}...`);
      return {
        success: false,
        error: `GitHub API error (${status}): ${message}`,
      };
    }
  }

  /**
   * List repositories accessible to the authenticated user
   * Uses the ISV access token obtained via OAuth STS brokered consent
   */
  static async listRepos(
    accessToken: string
  ): Promise<{ success: boolean; repos?: Array<{ name: string; full_name: string; private: boolean; html_url: string; description: string | null }>; error?: string }> {
    try {
      const response = await axios.get(
        'https://api.github.com/user/repos?per_page=30&sort=updated',
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }
      );

      const repos = response.data.map((r: any) => ({
        name: r.name,
        full_name: r.full_name,
        private: r.private,
        html_url: r.html_url,
        description: r.description,
      }));

      console.log(`✅ GitHub: Listed ${repos.length} repos`);
      return { success: true, repos };
    } catch (error: any) {
      const status = error.response?.status;
      const message = error.response?.data?.message || error.message;
      console.error(`❌ GitHub API error (${status}):`, message);
      console.error(`   Response headers:`, JSON.stringify(error.response?.headers || {}, null, 2));
      console.error(`   Response body:`, JSON.stringify(error.response?.data || {}, null, 2));
      console.error(`   Token prefix: ${accessToken.substring(0, 8)}...`);
      return {
        success: false,
        error: `GitHub API error (${status}): ${message}`,
      };
    }
  }
}
