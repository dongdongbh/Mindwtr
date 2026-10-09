package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AboutEndpointsTest {
    private val built = "https://feedback.example.test/submit"
    /** Every build type in build.gradle.kts but release: none may send real feedback. */
    private val testBuilds = listOf("debug", "upgradetest", "benchmark", "benchmarkSeed", "benchmarkTrace")

    @Test fun onlyAReleaseBuildSendsFeedbackToTheEndpointItWasBuiltWith() {
        assertEquals(built, aboutFeedbackEndpoint("release", built, null))
        for (build in testBuilds) assertEquals(build, "", aboutFeedbackEndpoint(build, built, null))
    }

    @Test fun aTestBuildSendsFeedbackOnlyToTheCheckStub() {
        val stub = aboutStub("8123")
        assertEquals("http://127.0.0.1:8123", stub)
        for (build in testBuilds) assertEquals(build, "http://127.0.0.1:8123/feedback", aboutFeedbackEndpoint(build, built, stub))
        // A release build never takes the stub (debug properties are read only in debug builds, too).
        assertEquals(built, aboutFeedbackEndpoint("release", built, stub))
    }

    @Test fun refusesAStubThatIsNotALocalPort() {
        for (port in listOf("", "0", "65536", "-1", "80a", "example.test:80")) assertNull(port, aboutStub(port))
    }

    @Test fun thisVariantFollowsTheRule() {
        if (BuildConfig.BUILD_TYPE != "release") assertEquals("", aboutFeedbackEndpoint(BuildConfig.BUILD_TYPE, BuildConfig.FEEDBACK_ENDPOINT_URL, null))
    }
}
