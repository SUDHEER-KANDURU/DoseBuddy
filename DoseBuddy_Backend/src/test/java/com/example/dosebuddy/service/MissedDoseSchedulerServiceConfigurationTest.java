package com.example.dosebuddy.service;

import com.example.dosebuddy.repository.ActivityRepository;
import com.example.dosebuddy.repository.IntakeLogRepository;
import com.example.dosebuddy.repository.MedicationRepository;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

import java.lang.reflect.Proxy;

import static org.assertj.core.api.Assertions.assertThat;

class MissedDoseSchedulerServiceConfigurationTest {

    private final ApplicationContextRunner contextRunner = new ApplicationContextRunner()
            .withBean(MedicationRepository.class, () -> emptyRepository(MedicationRepository.class))
            .withBean(IntakeLogRepository.class, () -> emptyRepository(IntakeLogRepository.class))
            .withBean(ActivityRepository.class, () -> emptyRepository(ActivityRepository.class))
            .withBean(ActivityService.class)
            .withUserConfiguration(MissedDoseSchedulerService.class);

    @Test
    void legacyMissedDoseWriterIsDisabledByDefault() {
        contextRunner.run(context -> assertThat(context).doesNotHaveBean(MissedDoseSchedulerService.class));
    }

    @Test
    void legacyMissedDoseWriterRequiresExplicitOptIn() {
        contextRunner
                .withPropertyValues("dosebuddy.legacy-missed-scheduler.enabled=true")
                .run(context -> assertThat(context).hasSingleBean(MissedDoseSchedulerService.class));
    }

    @SuppressWarnings("unchecked")
    private static <T> T emptyRepository(Class<T> type) {
        return (T) Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type},
                (proxy, method, args) -> {
                    if (method.getName().equals("toString")) return type.getSimpleName();
                    if (method.getReturnType().equals(boolean.class)) return false;
                    if (method.getReturnType().isPrimitive()) return 0;
                    return null;
                });
    }
}
