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
      return {
        success: false,
        error: `GitHub API error (${status}): ${message}`,
      };
    }
  }
}
