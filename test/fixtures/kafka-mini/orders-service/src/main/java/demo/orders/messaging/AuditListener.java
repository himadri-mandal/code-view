package demo.orders.messaging;

import demo.orders.domain.OrderPlaced;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class AuditListener {
  @EventListener
  public void onPlaced(OrderPlaced event) {
    System.out.println(event);
  }

  @Scheduled(cron = "0 0 * * * *")
  public void hourly() {
    System.out.println("tick");
  }
}
